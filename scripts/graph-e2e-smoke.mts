/**
 * 图谱页轻量浏览器冒烟（独立验证 Phase 4）。
 *
 * 用法：pnpm exec tsx scripts/graph-e2e-smoke.mts
 * 依赖：Playwright（Chromium 已缓存在 ~/.cache/ms-playwright）+ 本机 vendor
 * 目录（~/.doc77/vendor，含 4 个 d3 模块——运行 doc77 vendor-install 获取）。
 * 不在 CI 运行；浏览器不可用时打印 SKIP 退出 0。
 *
 * 覆盖：页面无 JS 错误 / canvas 渲染 / d3 vendor 加载 / 搜索定位 + 点击跳转 /
 * 洞察面板（孤儿 + 断链）/ SSE 连接 / 控件冒烟 / 项目 tab。
 */
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { chromium } from '@playwright/test';

import { initDatabase, closeConnection, getConnection } from '../packages/core/src/db/connection.js';
import { runMigrations } from '../packages/core/src/db/migrations.js';
import { createApp } from '../packages/core/src/server/app.js';
import { registerProject } from '../packages/core/src/db/projects.js';
import { fullGraphIndex } from '../packages/core/src/graph/indexer.js';
import { stopFileWatcher } from '../packages/core/src/server/watcher.js';

const consoleErrors: string[] = [];
const sseSeen: string[] = [];

async function waitCanvasPixels(page: import('@playwright/test').Page, minPixels: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => {
      const c = document.getElementById('graphCanvas') as HTMLCanvasElement | null;
      if (!c || !c.width) return -1;
      const ctx = c.getContext('2d');
      if (!ctx) return -1;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    if (count >= minPixels) return count;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`canvas non-blank timeout (got <${minPixels} alpha pixels)`);
}

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

async function main(): Promise<void> {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-e2e-'));
  const projDir = path.join(testDir, 'main');
  const proj2Dir = path.join(testDir, 'second');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(proj2Dir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'a.md'), '# A\n\n参见 [[b]] 和 [[ghost]]');
  fs.writeFileSync(path.join(projDir, 'b.md'), '# B\n\n回链 [[a]]');
  fs.writeFileSync(path.join(projDir, 'c.md'), '# C\n\n链接 [[b]]');
  fs.writeFileSync(path.join(projDir, 'z.md'), '# Z\n\n无链接');
  fs.writeFileSync(path.join(proj2Dir, 'd.md'), '# D\n\n参见 [[e]]');
  fs.writeFileSync(path.join(proj2Dir, 'e.md'), '# E\n\n回链 [[d]]');

  await initDatabase(path.join(testDir, 'data.db'));
  runMigrations();
  const pid = registerProject('E2E Main', projDir).id;
  const pid2 = registerProject('E2E Second', proj2Dir).id;
  await fullGraphIndex(pid, projDir);
  await fullGraphIndex(pid2, proj2Dir);

  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // 触发 FTS 索引（搜索定位依赖 /api/fts）
  await fetch(`${baseUrl}/api/fts/${pid}/index`, { method: 'POST' }).catch(() => {});
  await fetch(`${baseUrl}/api/fts/${pid2}/index`, { method: 'POST' }).catch(() => {});

  let browser: import('@playwright/test').Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    console.log(`SKIP: Chromium unavailable (${msg}). Run \`pnpm exec playwright install chromium\` and re-run.`);
    await cleanup(testDir, server);
    process.exit(0);
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // 预期噪音过滤：
      // - favicon/manifest 404
      // - dev 布局未编译 tailwind.css 的 `@import "tailwindcss"` 相对解析（/css/tailwindcss）
      // - 纯 core server 无 gallery 包 → /gallery/js/* 404（生产由 gallery 包挂载）
      const text = msg.text();
      const loc = msg.location();
      const url = loc ? loc.url : '';
      // 预期噪音：favicon/manifest 404、dev 布局未编译 tailwind.css 的
      // @import 相对解析、纯 core server 无 gallery 包（/gallery/js/* 404）
      if (
        /favicon|manifest\.json|net::ERR_ABORTED/.test(text) ||
        /css\/tailwindcss/.test(url) ||
        /gallery\//.test(url) ||
        /MIME type/.test(text)
      ) {
        return;
      }
      consoleErrors.push(loc ? `${text} @ ${loc.url}:${loc.lineNumber}` : text);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  const d3VendorSeen: string[] = [];
  page.on('request', (req) => {
    if (/\/api\/events/.test(req.url())) sseSeen.push(req.url());
    if (/\/vendor\/d3-(dispatch|quadtree|timer|force)\.min\.js/.test(req.url())) d3VendorSeen.push(req.url());
  });

  console.log('graph e2e smoke — assertions:');
  try {
    // ── 1. 页面加载 + canvas 非空白 + d3 vendor ──
    await page.goto(`${baseUrl}/graph`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#graphCanvas');
    const pixels = await waitCanvasPixels(page, 1000, 20000);
    assert(pixels > 0, `canvas 渲染非空白（${pixels} alpha 像素）`);
    const d3Ok = await page.evaluate(() => typeof (window as unknown as { d3?: { forceSimulation?: unknown } }).d3?.forceSimulation === 'function');
    assert(d3Ok, 'window.d3.forceSimulation 可用（物理引擎加载）');
    assert(d3VendorSeen.length >= 4, `d3 vendor 本地加载（${d3VendorSeen.length}/4 请求）`);
    await waitForNoError(); // 画完一轮后确认无 JS 错误

    // ── 2. 项目 tab：2 项目 + 全部 = 3 个按钮 ──
    const tabCount = await page.locator('#projectTabs button[data-pid]').count();
    assert(tabCount === 3, `项目 tab 数 = 项目数 + 1（${tabCount}）`);

    // ── 3. 搜索定位 + 点击打开 ──
    await page.fill('#nodeSearch', 'A');
    await page.waitForSelector('#searchResults button[data-hit]', { timeout: 10000 });
    await page.click('#searchResults button[data-hit] >> nth=0');
    await page.waitForTimeout(500); // focusNode 居中动画
    const box = await page.locator('#graphCanvas').boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForURL(new RegExp(`/preview\\.html\\?id=${pid}&path=a\\.md`), { timeout: 10000 });
    assert(true, '搜索定位 → 点击节点 → 跳转 preview (a.md)');

    // ── 4. 洞察面板：孤儿 + 断链 ──
    await page.goto(`${baseUrl}/graph`, { waitUntil: 'domcontentloaded' });
    await page.click('#insightsBtn');
    await page.waitForSelector('#insightsPanel:not(.hidden)', { timeout: 5000 });
    await page.click('#tabOrphans');
    const orphanText = await page.locator('#insightBody').textContent();
    assert(!!orphanText && orphanText.includes('z.md'), '孤立页列表含 z.md');
    await page.click('#tabBroken');
    const brokenText = await page.locator('#insightBody').textContent();
    assert(!!brokenText && brokenText.includes('ghost'), '死链列表含 [[ghost]]');
    await page.click('#insightBody button[data-open] >> nth=0');
    await page.waitForURL(new RegExp(`/preview\\.html\\?id=${pid}&path=a\\.md`), { timeout: 10000 });
    assert(true, '断链行点击 → 打开源文档 (a.md)');

    // ── 5. SSE 连接 ──
    assert(sseSeen.length > 0, `SSE /api/events 已连接（${sseSeen.length} 次请求）`);

    // ── 6. 控件冒烟：孤儿开关切换后重绘仍有像素 ──
    await page.goto(`${baseUrl}/graph`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#orphanDimToggle');
    await page.click('#orphanDimToggle');
    await page.waitForTimeout(300);
    const afterToggle = await waitCanvasPixels(page, 1000, 10000);
    assert(afterToggle > 0, `孤儿开关切换后仍渲染（${afterToggle} alpha 像素）`);

    // ── 7. 单项目 tab → 重建索引按钮可见 ──
    await page.click(`#projectTabs button[data-pid="${pid}"]`);
    const reindexVisible = await page.locator('#reindexBtn').isVisible();
    assert(reindexVisible, '单项目 tab → 重建索引按钮可见');

    await waitForNoError();

    // ── 8. 返回 Dashboard 入口（显式按钮）──
    await page.goto(`${baseUrl}/graph`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#backDashboard');
    const backHref = await page.getAttribute('#backDashboard', 'href');
    assert(backHref === '/', `返回按钮 href="/"（${backHref}）`);
    await page.click('#backDashboard');
    await page.waitForURL(`${baseUrl}/`, { timeout: 10000 });
    assert(true, '点击返回按钮 → 回到 dashboard');

    // ── 9. 大图降级：网格快速布局 + 手动启用力导向 ──
    const bigDir = path.join(testDir, 'big');
    fs.mkdirSync(bigDir, { recursive: true });
    fs.writeFileSync(path.join(bigDir, 'doc0.md'), '# Doc 0\n');
    const bigPid = registerProject('E2E Big', bigDir).id;
    // 2500 节点 raw SQL 直插（免 fullGraphIndex，对齐 graph-truncation.test.ts seedNodes）
    {
      const conn = getConnection();
      const tx = conn.transaction(() => {
        const ins = conn.prepare(
          'INSERT INTO doc_meta (project_id, file_path, title, tags) VALUES (?, ?, ?, ?)',
        );
        for (let i = 0; i < 2500; i++) ins.run(bigPid, `doc${i}.md`, `Doc ${i}`, '["tag-a"]');
      });
      tx();
    }
    await page.goto(`${baseUrl}/graph?projects=${bigPid}`, { waitUntil: 'domcontentloaded' });
    const hintVisible = await page
      .waitForSelector('#forceHint:not(.hidden)', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    assert(hintVisible, '大图（2500 节点）→ 快速布局横幅可见');
    const bigPixels = await waitCanvasPixels(page, 1000, 20000);
    assert(bigPixels > 0, `大图网格布局已渲染（${bigPixels} alpha 像素）`);
    await page.click('#forceEnableBtn');
    await page.waitForSelector('#forceHint.hidden', { timeout: 20000 });
    assert(true, '启用力导向布局 → 横幅隐藏');
    const forcePixels = await waitCanvasPixels(page, 1000, 20000);
    assert(forcePixels > 0, `力导向布局后仍渲染（${forcePixels} alpha 像素）`);

    // ── 10. 小图回归守卫：forceHint 不显示（防误降级）──
    // 单项目视图（5 节点，避免"全部项目"含大项目 2500 节点触发降级）
    await page.goto(`${baseUrl}/graph?projects=${pid}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#graphCanvas');
    await page.waitForTimeout(1500); // 等 loadData + 布局决策完成
    const hintShown = await page.locator('#forceHint:not(.hidden)').count();
    assert(hintShown === 0, '小图（5 节点）→ 快速布局横幅不显示');

    await waitForNoError();
  } finally {
    await browser.close();
    await cleanup(testDir, server);
  }

  async function waitForNoError(): Promise<void> {
    await page.waitForTimeout(500);
    assert(consoleErrors.length === 0, `无 JS console/page 错误（${consoleErrors.length ? consoleErrors.join(' | ') : 'clean'}）`);
  }

  console.log(failures === 0 ? '\n✅ 冒烟全部通过' : `\n❌ ${failures} 项断言失败`);
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup(testDir: string, server: http.Server): Promise<void> {
  try {
    stopFileWatcher();
  } catch {
    /* ignore */
  }
  server.close();
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
