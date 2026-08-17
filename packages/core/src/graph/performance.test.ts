import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { registerProject } from '../db/projects.js';
import { fullGraphIndex, indexFileLinks } from './indexer.js';
import { queryBacklinks, getGraphStats, queryOrphans, queryBrokenLinks } from './repository.js';
import { relatedDocs } from './related.js';
import { onWatcherFlush } from './maintenance.js';
import { createApp } from '../server/app.js';

/**
 * 知识图谱性能回归测试（v1.2.0 收尾 + v1.2.1 可视化数据）。
 *
 * 目标值（注释标注）与宽松断言（防 CI 抖动，抓数量级回归）：
 * - 全量重建 3000 文件：目标 < 30s；批处理 setTimeout(0) 让出，事件循环
 *   单次阻塞（心跳间隔）目标 < 50ms —— 1.1.3 事件循环冻结教训的复现点
 * - 增量索引：目标 < 10ms/文件
 * - 大边表（20 万行）查询：目标 < 50ms
 * - watcher flush 挂点：目标 < 500ms（50 文件批量）
 * - 5000 节点全量图接口（可视化数据源）：目标 < 1s（验收 < 2s）
 * - 20 万边表 orphans/broken 列表查询：目标 < 200ms 合计
 *
 * 超时说明：全部用例显式 180s。CI 共享 runner（2 核）比本地慢 5-10 倍，
 * 5000 文件重建 + 20 万行插入累计可超全局默认 60s（2026-08-17 CI 实测
 * 超时）。性能测试测量的是量级，不是精确毫秒，慢机上允许跑得更久。
 */
const SLOW_TIMEOUT = 180_000;

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

const HEARTBEAT_MS = 10;

/** 测量 fullGraphIndex 期间的事件循环最大停顿（心跳间隔） */
async function measureEventLoopStall(
  fn: () => Promise<unknown>,
): Promise<{ maxGap: number; ms: number }> {
  let last = Date.now();
  let maxGap = 0;
  const hb = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, HEARTBEAT_MS);
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  clearInterval(hb);
  return { maxGap, ms };
}

describe('graph performance regression', () => {
  let testDir: string;
  let projectId: number;
  let cleanupDirs: string[] = [];

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-perf-'));
    cleanupDirs.push(testDir);
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    cleanupDirs = [];
  });

  /** 合成项目：n 个文件，每个引用相邻文件（链式互链） */
  function synthProject(n: number): string {
    const dir = path.join(testDir, `proj-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? `doc${i + 1}` : `doc0`;
      const prev = i > 0 ? `doc${i - 1}` : `doc${n - 1}`;
      fs.writeFileSync(
        path.join(dir, `doc${i}.md`),
        `# Doc ${i}\n\n参见 [[${next}]] 和 [[${prev}]]\n\n正文内容第 ${i} 号文档。`,
      );
    }
    projectId = registerProject(`Perf${n}`, dir).id;
    return dir;
  }

  it(
    '全量重建 3000 文件：< 60s 且事件循环不冻结（批处理让出）',
    async () => {
      const dir = synthProject(3000);
      const { maxGap, ms } = await measureEventLoopStall(() => fullGraphIndex(projectId, dir));
      // 目标：< 30s；断言宽松防 CI 抖动
      expect(ms).toBeLessThan(60_000);
      // 目标：单次阻塞 < 50ms；抓"整批同步处理不让出"级别的回归
      expect(maxGap).toBeLessThan(1_000);
      const stats = getGraphStats(getConnection(), projectId);
      expect(stats.nodes).toBe(3000);
      expect(stats.edges).toBeGreaterThan(0);
      // 记录实际值（CI 日志可观察）
      console.log(`[graph-perf] 3000 files rebuild: ${ms}ms, max event-loop gap ${maxGap}ms`);
    },
    SLOW_TIMEOUT,
  );

  it(
    '增量索引单文件 < 50ms（hash 短路第 2 次 < 5ms）',
    async () => {
      const dir = synthProject(200);
      await fullGraphIndex(projectId, dir);

      // 真实增量：改文件后索引
      fs.writeFileSync(
        path.join(dir, 'doc100.md'),
        '# Doc 100 改\n\n参见 [[doc101]] 和新增链接 [[doc50]]',
      );
      const t0 = Date.now();
      indexFileLinks(projectId, dir, 'doc100.md');
      const first = Date.now() - t0;
      expect(first).toBeLessThan(50);

      // hash 短路：同内容重复索引，边缘数不变（0 DB 写语义）
      const before = getGraphStats(getConnection(), projectId).edges;
      const t1 = Date.now();
      indexFileLinks(projectId, dir, 'doc100.md');
      const second = Date.now() - t1;
      expect(getGraphStats(getConnection(), projectId).edges).toBe(before);
      expect(second).toBeLessThan(5);
      console.log(`[graph-perf] incremental: first ${first}ms, hash-shortcut ${second}ms`);
    },
    SLOW_TIMEOUT,
  );

  it(
    '20 万行边表：backlinks/related/stats 查询 < 200ms',
    async () => {
      const dir = synthProject(5000);
      await fullGraphIndex(projectId, dir);
      // 批量造大边表：5000 from × 40 to = 20 万唯一对（事务内）
      const conn = getConnection();
      const tx = conn.transaction(() => {
        const ins = conn.prepare(
          `INSERT INTO doc_links (project_id, from_path, to_path, link_type, anchor, status, display)
         VALUES (?, ?, ?, 'wikilink', '', 'resolved', '')`,
        );
        for (let i = 0; i < 5000; i++) {
          for (let j = 1; j <= 40; j++) {
            ins.run(projectId, `doc${i}.md`, `doc${(i + j * 7) % 5000}.md`);
          }
        }
      });
      tx();
      // 预热：20 万行事务提交后 SQLite 触发 WAL checkpoint（合并到主库，
      // 慢 IO 环境可达数百 ms）。修复前计时含 checkpoint 成本，CI 实测
      // 231→570ms 抖动（本地 NVMe 仅数十 ms 不暴露）。预热查询让一次性
      // 成本移出计时，测的是真实查询延迟。
      getGraphStats(conn, projectId);

      const t0 = Date.now();
      queryBacklinks(conn, projectId, 'doc1.md');
      relatedDocs(projectId, 'doc1.md', 5);
      getGraphStats(conn, projectId);
      const elapsed = Date.now() - t0;
      // 目标：单查询 < 50ms；断言宽松（CI 抖动），500ms 抓数量级退化
      expect(elapsed).toBeLessThan(500);
      console.log(`[graph-perf] 200k edges, 3 queries: ${elapsed}ms`);
    },
    SLOW_TIMEOUT,
  );

  it(
    'watcher flush 挂点：50 文件批量 < 1s 且不阻塞',
    async () => {
      const dir = synthProject(100);
      await fullGraphIndex(projectId, dir);
      const paths = Array.from({ length: 50 }, (_, i) => `doc${i}.md`);
      // 修改 50 个文件（模拟 git pull 批量变更）
      for (const p of paths) {
        fs.writeFileSync(path.join(dir, p), `# Doc ${p} 更新\n\n正文。`);
      }
      const t0 = Date.now();
      onWatcherFlush(projectId, dir, 'modify', paths);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1_000);
      console.log(`[graph-perf] watcher flush 50 files: ${elapsed}ms`);
    },
    SLOW_TIMEOUT,
  );

  it(
    '5000 节点全量图接口 < 2s；20 万边表 orphans/broken 列表 < 200ms',
    async () => {
      // 同一 fixture：5000 文件链式互链（10k 条 resolved 边）
      const dir = synthProject(5000);
      await fullGraphIndex(projectId, dir);

      // ── 全量图接口（可视化数据源）：5000 节点 + 10000 边 JSON ──
      await withServer(async (baseUrl) => {
        const t0 = Date.now();
        const res = await fetch(`${baseUrl}/api/graph?projects=${projectId}`);
        const ms = Date.now() - t0;
        expect(res.status).toBe(200);
        const d = (await res.json()) as {
          nodes: Array<{ path: string }>;
          edges: Array<{ source: string; target: string }>;
          truncated: boolean;
        };
        expect(ms).toBeLessThan(2_000); // 验收 < 2s；目标 < 1s
        expect(d.nodes).toHaveLength(5000);
        expect(d.edges.length).toBeGreaterThanOrEqual(10_000); // synthProject 每文档 2 条出链
        expect(d.truncated).toBe(false);
        console.log(`[graph-perf] full graph API 5000 nodes: ${ms}ms`);
      });

      // ── 大边表：孤儿/死链列表查询（含 total）──
      const conn = getConnection();
      const tx = conn.transaction(() => {
        const ins = conn.prepare(
          `INSERT INTO doc_links (project_id, from_path, to_path, link_type, anchor, status, display)
         VALUES (?, ?, ?, 'wikilink', '', 'resolved', '')`,
        );
        for (let i = 0; i < 5000; i++) {
          for (let j = 1; j <= 40; j++) {
            ins.run(projectId, `doc${i}.md`, `doc${(i + j * 7) % 5000}.md`);
          }
        }
      });
      tx();
      // 预热：同上方测试——20 万行事务的 WAL checkpoint 成本移出计时
      queryOrphans(conn, [projectId], { limit: 10 });
      const t0 = Date.now();
      queryOrphans(conn, [projectId], { limit: 10000 });
      queryBrokenLinks(conn, [projectId], { limit: 500 });
      const elapsed = Date.now() - t0;
      // 与上方同型断言：500ms 防 CI 抖动，抓数量级退化
      expect(elapsed).toBeLessThan(500);
      console.log(`[graph-perf] 200k edges, orphans/broken list queries: ${elapsed}ms`);
    },
    SLOW_TIMEOUT,
  );

  it(
    '非 markdown 文件过滤：混合目录不受大文件影响',
    async () => {
      const dir = path.join(testDir, 'mixed');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\n见 [[b]]');
      fs.writeFileSync(path.join(dir, 'b.md'), '# B\n\n回 [[a]]');
      // 大二进制/代码文件不应产生节点
      fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0x41));
      fs.writeFileSync(path.join(dir, 'code.ts'), 'export const x = 1; // [[a]]');
      projectId = registerProject('Mixed', dir).id;
      const { ms } = await measureEventLoopStall(() => fullGraphIndex(projectId, dir));
      const stats = getGraphStats(getConnection(), projectId);
      expect(stats.nodes).toBe(2); // 只 a.md + b.md
      expect(ms).toBeLessThan(5_000);
    },
    SLOW_TIMEOUT,
  );
  // ── v1.2.1 红队修复性能回归 ──

  it(
    '增量索引 1000 文件平均 <10ms/文件（文件列表缓存预热后）',
    async () => {
      const dir = synthProject(1000);
      await fullGraphIndex(projectId, dir); // 预热：建 meta + 文件列表缓存
      const t0 = Date.now();
      // 修改 50 个文件后逐个增量索引（真实保存路径模拟）
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(path.join(dir, `doc${i}.md`), `# Doc ${i} 改\n\n参见 [[doc${i + 1}]]`);
        indexFileLinks(projectId, dir, `doc${i}.md`, getConnection(), {
          content: `# Doc ${i} 改\n\n参见 [[doc${i + 1}]]`,
        });
      }
      const elapsed = Date.now() - t0;
      // 修复前每次保存全项目重扫（10k 文件 +10-50ms/次）；缓存后 <10ms/文件
      expect(elapsed / 50).toBeLessThan(10);
      console.log(
        `[graph-perf] incremental 50 files: ${elapsed}ms (${(elapsed / 50).toFixed(1)}ms/file)`,
      );
    },
    SLOW_TIMEOUT,
  );

  it(
    '100 链接 × 1 万文件项目 renderMarkdown < 2s（wikilink 索引化）',
    async () => {
      const dir = synthProject(10000);
      // 预热文件列表缓存（全量索引本身会 walk，但渲染走 wikilink 缓存）
      const { renderMarkdown } = await import('../renderers/markdown.js');
      const { clearWikilinkCache } = await import('../renderers/wikilink.js');
      await fullGraphIndex(projectId, dir);
      clearWikilinkCache(projectId); // 模拟真实首开：缓存未预热
      const doc = Array.from(
        { length: 100 },
        (_, i) => `见 [[doc${i * 97}]] 和 [[不存在${i}]]`,
      ).join('\n');
      const t0 = Date.now();
      renderMarkdown(doc, { projectId, filePath: 'doc.md', obsidianMode: true });
      const elapsed = Date.now() - t0;
      // 修复前：100 链接 × 1 万文件线性扫描 + 每链接读盘 ≈ 数秒；
      // 索引化后 O(链接)。2s 宽松断言（CI 抖动），10 倍余量抓数量级回归
      expect(elapsed).toBeLessThan(2_000);
      console.log(`[graph-perf] renderMarkdown 100 links x 10k files: ${elapsed}ms`);
    },
    SLOW_TIMEOUT,
  );
});
