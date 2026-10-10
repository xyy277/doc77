/**
 * graph-perf-bench.mts — 图谱性能基准（本地实测，非 CI）。
 *
 * 目的：量化"图谱卡顿"，把主观感受拆成可测量的指标：
 *   A. 服务端：全量索引耗时 / 事件循环最大停顿 / 图谱 API 延迟 + payload 大小
 *   B. 浏览器：首帧延迟 / 交互期主线程占用率 / long task / rAF 帧率 / JS 堆
 *
 * 用法：
 *   pnpm exec tsx scripts/graph-perf-bench.mts                # 默认 5000 节点
 *   pnpm exec tsx scripts/graph-perf-bench.mts 1000 5000      # 多规模
 *   pnpm exec tsx scripts/graph-perf-bench.mts 5000 --server-only
 *   pnpm exec tsx scripts/graph-perf-bench.mts 5000 --keep     # 保留生成的项目目录
 *
 * 说明：
 * - 项目文件生成在 .workbuddy/tmp/graph-perf-<n>/，已存在时复用。
 * - 浏览器优先用 bundled chromium，缺失则回退系统 Chrome / Edge。
 * - 帧率用 rAF 采样；headless 合成器可能节流 rAF，故同时给出 CDP
 *   TaskDuration（主线程占用率）作为**不依赖合成器**的卡顿主指标。
 */
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { initDatabase, closeConnection } from '../packages/core/src/db/connection.js';
import { runMigrations } from '../packages/core/src/db/migrations.js';
import { createApp } from '../packages/core/src/server/app.js';
import { registerProject, listProjects } from '../packages/core/src/db/projects.js';
import { fullGraphIndex } from '../packages/core/src/graph/indexer.js';
import { stopFileWatcher } from '../packages/core/src/server/watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(ROOT, '.workbuddy', 'tmp');

const argv = process.argv.slice(2);
const serverOnly = argv.includes('--server-only');
const keep = argv.includes('--keep');
const sizes = argv
  .filter((a) => /^\d+$/.test(a))
  .map((a) => parseInt(a, 10))
  .filter((n) => n > 0);
const NODES = sizes.length ? sizes : [5000];

// ────────────────────────────── 工具 ──────────────────────────────

function fmt(ms: number): string {
  if (ms < 0) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function kb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
}

interface FrameStats {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  max: number;
  janky: number;
  stalled: number;
}

function frameStats(gaps: number[]): FrameStats {
  if (!gaps.length) return { frames: 0, fps: 0, p50: 0, p95: 0, max: 0, janky: 0, stalled: 0 };
  const sorted = [...gaps].sort((a, b) => a - b);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return {
    frames: gaps.length,
    fps: +(1000 / avg).toFixed(1),
    p50: +percentile(sorted, 0.5).toFixed(1),
    p95: +percentile(sorted, 0.95).toFixed(1),
    max: +Math.max(...gaps).toFixed(1),
    janky: gaps.filter((g) => g > 33).length,
    stalled: gaps.filter((g) => g > 100).length,
  };
}

function fmtFrames(s: FrameStats): string {
  if (!s.frames) return 'fps=n/a（rAF 未触发）';
  return `fps=${s.fps} p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms 掉帧(>33ms)=${s.janky} 卡死帧(>100ms)=${s.stalled} [${s.frames}帧]`;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);
}

/** 合成项目：n 个 markdown，环形互链（每文件 2 出链 → ~2n 边） */
function synthProject(dir: string, n: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, '.synth-ok');
  if (fs.existsSync(marker)) {
    try {
      const meta = JSON.parse(fs.readFileSync(marker, 'utf8')) as { n: number };
      if (meta.n === n) return dir;
    } catch {
      /* regenerate */
    }
  }
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? `doc${String(i + 1).padStart(5, '0')}` : `doc00000`;
    const prev = i > 0 ? `doc${String(i - 1).padStart(5, '0')}` : `doc${String(n - 1).padStart(5, '0')}`;
    let links = `参见 [[${next}]] 和 [[${prev}]]`;
    if (i % 500 === 0) links += ` 以及 [[missing-target-${i}]]`;
    if (i === 1) links += ` 以及 [[doc00500]]`;
    fs.writeFileSync(
      path.join(dir, `doc${String(i).padStart(5, '0')}.md`),
      `# Doc ${i}\n\n${links}\n\n合成性能验证文档第 ${i} 号。\n`,
    );
  }
  fs.writeFileSync(marker, JSON.stringify({ n }));
  return dir;
}

/** 测量事件循环最大停顿（心跳间隔） */
async function measureEventLoopStall<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; maxGap: number; ms: number }> {
  let last = Date.now();
  let maxGap = 0;
  const hb = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  clearInterval(hb);
  return { result, maxGap, ms };
}

async function fetchTimed(
  url: string,
): Promise<{ ms: number; status: number; bytes: number; json?: unknown }> {
  const t0 = Date.now();
  const res = await fetch(url);
  const text = await res.text();
  const ms = Date.now() - t0;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { ms, status: res.status, bytes: Buffer.byteLength(text), json };
}

// ────────────────────────── Phase A：服务端 ──────────────────────────

interface ServerBenchResult {
  n: number;
  indexMs: number;
  indexMaxGap: number;
  nodes: number;
  edges: number;
  graphApiMs: number;
  graphApiBytes: number;
}

async function benchServer(n: number): Promise<ServerBenchResult> {
  console.log(`\n${'═'.repeat(76)}`);
  console.log(` 服务端基准 · ${n} 文件项目`);
  console.log('═'.repeat(76));

  const workDir = path.join(TMP_ROOT, `graph-perf-${n}`);
  const projDir = path.join(workDir, 'vault');
  const dbPath = path.join(workDir, 'data.db');

  fs.mkdirSync(workDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${dbPath}${suffix}`;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }

  const tGen = Date.now();
  synthProject(projDir, n);
  console.log(` · 合成项目就绪 (${fmt(Date.now() - tGen)})`);

  await initDatabase(dbPath);
  runMigrations();
  const pid = registerProject(`Perf${n}`, projDir).id;

  const { maxGap, ms } = await measureEventLoopStall(() => fullGraphIndex(pid, projDir));
  console.log(` · 全量索引: ${fmt(ms)}   事件循环最大停顿: ${maxGap}ms`);

  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const endpoints: Array<{ name: string; url: string }> = [
    { name: 'GET /api/graph（全量图）', url: `/api/graph?projects=${pid}` },
    { name: 'GET /api/graph (mode=full)', url: `/api/graph?projects=${pid}&mode=full` },
    { name: 'GET /api/graph/stats', url: `/api/graph/stats?projects=${pid}` },
    { name: 'GET /api/graph/orphans', url: `/api/graph/orphans?projects=${pid}&limit=10000` },
    { name: 'GET /api/graph/broken', url: `/api/graph/broken?projects=${pid}&limit=500` },
    { name: 'GET /graph（HTML）', url: '/graph' },
  ];

  let graphApiMs = 0;
  let graphApiBytes = 0;
  let nodeCount = 0;
  let edgeCount = 0;
  for (const ep of endpoints) {
    try {
      await fetchTimed(`${base}${ep.url}`); // 预热
      const r = await fetchTimed(`${base}${ep.url}`);
      let extra = '';
      const j = r.json as Record<string, unknown> | undefined;
      if (j) {
        if (Array.isArray(j.nodes)) {
          nodeCount = j.nodes.length;
          edgeCount = (j.edges as unknown[])?.length ?? 0;
          extra = `nodes=${nodeCount} edges=${edgeCount} truncated=${String(j.truncated)}`;
        } else if (Array.isArray(j.orphans) || Array.isArray(j.broken)) {
          extra = `rows=${((j.orphans || j.broken) as unknown[]).length} total=${String(j.total)}`;
        } else if (j.total && typeof j.total === 'object') {
          const t = j.total as { nodes: number; edges: number; broken: number; orphans: number };
          extra = `nodes=${t.nodes} edges=${t.edges} broken=${t.broken} orphans=${t.orphans}`;
        }
      }
      if (ep.name.startsWith('GET /api/graph（')) {
        graphApiMs = r.ms;
        graphApiBytes = r.bytes;
      }
      console.log(` · ${ep.name.padEnd(28)} ${fmt(r.ms).padStart(9)}  ${kb(r.bytes).padStart(8)}  ${extra}`);
    } catch (e) {
      console.log(` · ${ep.name.padEnd(28)} FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  const repeat: number[] = [];
  for (let i = 0; i < 3; i++) repeat.push((await fetchTimed(`${base}/api/graph?projects=${pid}`)).ms);
  console.log(` · /api/graph 连续 3 次: ${repeat.map((m) => fmt(m)).join(' / ')}`);

  server.close();
  stopFileWatcher();
  try {
    closeConnection();
  } catch {
    /* ignore */
  }

  return {
    n,
    indexMs: ms,
    indexMaxGap: maxGap,
    nodes: nodeCount,
    edges: edgeCount,
    graphApiMs,
    graphApiBytes,
  };
}

// ────────────────────────── Phase B：浏览器 ──────────────────────────

async function launchBrowser(
  chromium: typeof import('@playwright/test').chromium,
): Promise<{ browser: import('@playwright/test').Browser; label: string }> {
  const base = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  const attempts: Array<{ label: string; opts: Record<string, unknown> }> = [
    { label: 'bundled chromium', opts: {} },
    { label: 'system Chrome', opts: { channel: 'chrome' } },
    { label: 'system Edge', opts: { channel: 'msedge' } },
  ];
  const errs: string[] = [];
  for (const a of attempts) {
    try {
      const b = await chromium.launch({ ...base, ...a.opts });
      return { browser: b, label: a.label };
    } catch (e) {
      errs.push(`${a.label}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  throw new Error(`无法启动浏览器 — ${errs.join(' ; ')}`);
}

interface InteractionResult {
  elapsedMs: number;
  events: number;
  taskMs: number;
  scriptMs: number;
  taskPct: number;
  longTasks: number;
  longTaskMs: number;
  frames: FrameStats;
}

async function benchBrowser(n: number): Promise<void> {
  const { chromium } = await import('@playwright/test');
  const workDir = path.join(TMP_ROOT, `graph-perf-${n}`);
  const projDir = path.join(workDir, 'vault');
  const dbPath = path.join(workDir, 'data.db');

  console.log(`\n${'═'.repeat(76)}`);
  console.log(` 浏览器渲染基准 · ${n} 节点项目`);
  console.log('═'.repeat(76));

  await initDatabase(dbPath);
  runMigrations();
  const existing = listProjects().find((p) => p.path === projDir);
  const pid = existing ? existing.id : registerProject(`Perf${n}`, projDir).id;

  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const { browser, label } = await launchBrowser(chromium);
  console.log(` · 浏览器: ${label}`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|manifest|gallery\/|tailwindcss/.test(m.text())) {
      consoleErrors.push(m.text());
    }
  });

  await page.addInitScript(() => {
    // tsx/esbuild keepNames 注入的 helper 在浏览器上下文不存在 → polyfill
    (window as unknown as { __name: unknown }).__name = (fn: unknown) => fn;
    (window as unknown as { __longTasks: number[] }).__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          (window as unknown as { __longTasks: number[] }).__longTasks.push(e.duration);
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* unsupported */
    }
  });

  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');

  const readMetrics = async (): Promise<Record<string, number>> => {
    const r = (await client.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
    const out: Record<string, number> = {};
    for (const m of r.metrics) out[m.name] = m.value;
    return out;
  };

  const url = `${base}/graph?projects=${pid}`;
  console.log(` · URL: ${url}`);

  // ── 首帧 ──
  const t0 = Date.now();
  await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded' }), 30_000, 'goto');
  const navTiming = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      ttfb: Math.round(nav?.responseStart ?? 0),
      dcl: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      load: Math.round(nav?.loadEventEnd ?? 0),
    };
  });

  let firstPixel = -1;
  while (Date.now() - t0 < 30_000) {
    const px = await withTimeout(
      page.evaluate(() => {
        const c = document.getElementById('graphCanvas') as HTMLCanvasElement | null;
        if (!c || !c.width) return -1;
        const ctx = c.getContext('2d');
        if (!ctx) return -1;
        const d = ctx.getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data;
        let cnt = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) cnt++;
        return cnt;
      }),
      15_000,
      'canvas probe',
    ).catch(() => -1);
    if (px > 500) {
      firstPixel = Date.now() - t0;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(
    ` · 首帧（导航→canvas 有像素）: ${fmt(firstPixel)}   [TTFB ${navTiming.ttfb}ms / DCL ${navTiming.dcl}ms / load ${navTiming.load}ms]`,
  );

  const forceHintVisible = await page.locator('#forceHint:not(.hidden)').count();
  const layoutMode = forceHintVisible > 0 ? '网格降级（>2000 节点）' : '力导向自动布局';
  console.log(` · 布局模式: ${layoutMode}`);

  // ── 交互测量 ──
  const startSampling = () =>
    page.evaluate(() => {
      const w = window as unknown as { __gaps: number[]; __sampling: boolean; __longTasks: number[] };
      w.__gaps = [];
      w.__sampling = true;
      w.__longTasks = [];
      let last = 0;
      const tick = (ts: number) => {
        if (!w.__sampling) return;
        if (last) w.__gaps.push(ts - last);
        last = ts;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  const stopSampling = () =>
    page.evaluate(() => {
      const w = window as unknown as { __gaps: number[]; __sampling: boolean; __longTasks: number[] };
      w.__sampling = false;
      return { gaps: w.__gaps, longTasks: w.__longTasks };
    });

  type SimKind = 'pan' | 'zoom' | 'hover' | 'dragnode';

  const simulate = (kind: SimKind, durationMs: number) =>
    page.evaluate(
      async ({ k, duration }) => {
        const c = document.getElementById('graphCanvas') as HTMLCanvasElement;
        const rect = c.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const mk = (type: string, x: number, y: number, buttons = 0) =>
          new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            button: 0,
            buttons,
            isPrimary: true,
            pointerType: 'mouse',
          });
        const tick = () =>
          new Promise<void>((r) => {
            let done = false;
            const fin = () => {
              if (!done) {
                done = true;
                r();
              }
            };
            requestAnimationFrame(fin);
            setTimeout(fin, 32);
          });

        let events = 0;
        const t0 = performance.now();
        if (k === 'pan') {
          // 起点选画布左上角空白区：确保走"平移"路径而非命中节点后的"拖节点"路径
          const sx = rect.left + 6;
          const sy = rect.top + 6;
          c.dispatchEvent(mk('pointerdown', sx, sy, 1));
          while (performance.now() - t0 < duration) {
            const t = (performance.now() - t0) / 1000;
            c.dispatchEvent(mk('pointermove', sx + Math.sin(t * 3) * 180, sy + Math.cos(t * 2.3) * 120, 1));
            events++;
            await tick();
          }
          c.dispatchEvent(mk('pointerup', sx, sy, 0));
        } else if (k === 'zoom') {
          let dir = 1;
          while (performance.now() - t0 < duration) {
            c.dispatchEvent(
              new WheelEvent('wheel', { clientX: cx, clientY: cy, deltaY: dir * 120, bubbles: true, cancelable: true }),
            );
            dir = -dir;
            events++;
            await tick();
          }
        } else if (k === 'hover') {
          // 纯 hover：不按键，走 hitTest + showTooltip 路径
          while (performance.now() - t0 < duration) {
            const t = (performance.now() - t0) / 1000;
            c.dispatchEvent(mk('pointermove', cx + Math.sin(t * 3) * 220, cy + Math.cos(t * 2.3) * 160, 0));
            events++;
            await tick();
          }
        } else {
          // dragnode：先扫描画布找一个真节点（hover 时 cursor 变 pointer），再拖它
          let target: [number, number] | null = null;
          for (let gy = 0; gy < 12 && !target; gy++) {
            for (let gx = 0; gx < 20; gx++) {
              const x = rect.left + ((gx + 0.5) * rect.width) / 20;
              const y = rect.top + ((gy + 0.5) * rect.height) / 12;
              c.dispatchEvent(mk('pointermove', x, y, 0));
              if (c.style.cursor === 'pointer') {
                target = [x, y];
                break;
              }
            }
          }
          if (!target) target = [cx, cy];
          c.dispatchEvent(mk('pointerdown', target[0], target[1], 1));
          while (performance.now() - t0 < duration) {
            const t = (performance.now() - t0) / 1000;
            c.dispatchEvent(mk('pointermove', target[0] + Math.sin(t * 4) * 60, target[1] + Math.cos(t * 4) * 60, 1));
            events++;
            await tick();
          }
          c.dispatchEvent(mk('pointerup', target[0], target[1], 0));
        }
        return { events, ms: performance.now() - t0 };
      },
      { k: kind, duration: durationMs },
    );

  const runInteraction = async (label: string, kind: SimKind, durationMs: number): Promise<InteractionResult | null> => {
    try {
      const before = await readMetrics();
      await startSampling();
      const sim = await withTimeout(simulate(kind, durationMs), durationMs + 20_000, label);
      const { gaps, longTasks } = await stopSampling();
      const after = await readMetrics();
      const taskMs = Math.max(0, ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000);
      const scriptMs = Math.max(0, ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000);
      const frames = frameStats(gaps);
      const ltMs = longTasks.reduce((a, b) => a + b, 0);
      const res: InteractionResult = {
        elapsedMs: sim.ms,
        events: sim.events,
        taskMs,
        scriptMs,
        taskPct: +((taskMs / sim.ms) * 100).toFixed(1),
        longTasks: longTasks.length,
        longTaskMs: ltMs,
        frames,
      };
      console.log(
        ` · ${label.padEnd(20)} 主线程占用 ${res.taskPct}%（${fmt(taskMs)} / ${fmt(sim.ms)}，${sim.events} 次事件）` +
          `  longTask ${longTasks.length} 次 ${fmt(ltMs)}  ${fmtFrames(frames)}`,
      );
      return res;
    } catch (e) {
      console.log(` · ${label.padEnd(20)} FAILED: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  };

  await page.waitForTimeout(2000); // 等初始渲染稳定
  await runInteraction('拖拽平移 3s', 'pan', 3000);
  await runInteraction('滚轮缩放 3s', 'zoom', 3000);
  await runInteraction('悬停移动 3s', 'hover', 3000);
  await runInteraction('拖拽节点 3s', 'dragnode', 3000);

  if (forceHintVisible > 0) {
    // 手动启用力导向（大图降级路径）
    try {
      await page.click('#forceEnableBtn');
      await page.waitForTimeout(4000);
      console.log(' · — 已手动启用力导向布局 —');
      await runInteraction('力导向+拖拽 3s', 'pan', 3000);
      await runInteraction('力导向+缩放 3s', 'zoom', 3000);
    } catch (e) {
      console.log(` · 力导向启用失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── 静置：模拟收敛后是否还在烧 CPU ──
  try {
    const before = await readMetrics();
    await new Promise((r) => setTimeout(r, 3000));
    const after = await readMetrics();
    const taskMs = Math.max(0, ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000);
    console.log(` · 静置 3s 主线程占用: ${fmt(taskMs)}（${((taskMs / 3000) * 100).toFixed(1)}%）`);
  } catch {
    /* ignore */
  }

  const mem = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? m.usedJSHeapSize : 0;
  });
  console.log(` · JS 堆: ${mem ? kb(mem) : 'n/a'}`);

  // ── reload 首帧（含服务端数据重取）──
  const rt0 = Date.now();
  try {
    await withTimeout(page.reload({ waitUntil: 'domcontentloaded' }), 30_000, 'reload');
    let reloadFirst = -1;
    while (Date.now() - rt0 < 25_000) {
      const px = await withTimeout(
        page.evaluate(() => {
          const c = document.getElementById('graphCanvas') as HTMLCanvasElement | null;
          if (!c || !c.width) return -1;
          const ctx = c.getContext('2d');
          if (!ctx) return -1;
          const d = ctx.getImageData(0, 0, Math.min(c.width, 300), Math.min(c.height, 300)).data;
          let cnt = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) cnt++;
          return cnt;
        }),
        15_000,
        'reload probe',
      ).catch(() => -1);
      if (px > 300) {
        reloadFirst = Date.now() - rt0;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(` · 页面 reload 首帧: ${fmt(reloadFirst)}`);
  } catch (e) {
    console.log(` · reload 失败: ${e instanceof Error ? e.message : e}`);
  }

  console.log(
    consoleErrors.length
      ? ` · ⚠ 控制台错误 ${consoleErrors.length} 条: ${consoleErrors.slice(0, 2).join(' | ')}`
      : ' · 控制台无错误',
  );

  await browser.close();
  server.close();
  stopFileWatcher();
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
}

// ────────────────────────────── main ──────────────────────────────

async function main(): Promise<void> {
  const t0 = Date.now();
  const results: ServerBenchResult[] = [];

  for (const n of NODES) results.push(await benchServer(n));

  if (!serverOnly) {
    for (const n of NODES) {
      try {
        await benchBrowser(n);
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
        console.log(`\n⚠ ${n} 节点浏览器基准失败（${msg}）`);
        break;
      }
    }
  }

  console.log(`\n${'═'.repeat(76)}`);
  console.log(' 汇总');
  console.log('═'.repeat(76));
  console.log(' 规模\t索引耗时\t事件循环停顿\t节点\t边\t/api/graph');
  for (const r of results) {
    console.log(
      ` ${r.n}\t${fmt(r.indexMs)}\t${r.indexMaxGap}ms\t\t${r.nodes}\t${r.edges}\t${fmt(r.graphApiMs)} / ${kb(r.graphApiBytes)}`,
    );
  }
  console.log(`\n 总耗时 ${fmt(Date.now() - t0)}`);

  if (!keep) {
    for (const n of NODES) {
      try {
        fs.rmSync(path.join(TMP_ROOT, `graph-perf-${n}`), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    console.log(' （临时项目已清理；--keep 可保留以便复跑）');
  }
}

main().catch((e) => {
  console.error('bench failed:', e);
  process.exit(1);
});
