/**
 * 接线回归实证测试（wiring-regression）
 * ============================================================================
 * 背景：现有「接线」测试（sync-routes / rag / plugin-sandbox）把路由函数挂到
 * 隔离的简易测试 app 上跑，没有任何测试真正启动服务器、发真实 fetch 断言新路由
 * 可达 —— 这正是架构师指出的「虚假信心」源头。
 *
 * 本文件把读码推断变成实证，分两部分：
 *
 *  A) CLI 实证 —— 复刻 packages/cli/src/bin/doc77.ts:305-414 的挂载序列
 *     （T8 registerSyncRoutes / T10 registerAiRagRoutes / T11 registerPluginRoutes），
 *     起真实 http server，对以下路径发真实 fetch，断言返回 200：
 *       - GET  /api/sync/configs/1   (先 PUT 配置 → GET 200)
 *       - POST /api/ai/rag/index
 *       - POST /api/plugins/install
 *       - GET  /api/tunnel/config     (core 内置，createApp 内注册)
 *       - GET  /api/ai/providers      (core 内置，createApp 内注册)
 *
 *  B) Electron 实证 —— 调用 packages/electron/src/server.ts 导出的真实挂载函数
 *     registerHttpRoutes()（registerInstalledModules 内部使用同一函数），起真实
 *     http server，断言 sync/rag/plugin 路径返回 200 —— 修复后的 Electron 接线
 *     P0 缺口回归验证。
 *
 * 依赖解析说明：CLI 包声明了 @doc77/core / @doc77/ai(peer) / @doc77/gallery，
 * 但**未**声明 @doc77/sync（与 doc77.ts 运行时 dynamic import 一致，依赖 workspace
 * hoisting）。因此本测试对 @doc77/sync 使用相对源码路径导入，其余用裸导入。
 * ============================================================================
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// 裸导入（CLI 包 node_modules 已具备）：
import {
  createApp,
  initDatabase,
  runMigrations,
  getConnection,
  closeConnection,
  registerAiRagRoutes,
  registerPluginRoutes,
} from '@doc77/core';
import { RagEngine } from '@doc77/ai';

// 相对源码导入（CLI 未声明 @doc77/sync 依赖，使用相对路径直接加载当前源码）：
import { createSyncEngine, registerSyncRoutes, createSyncScheduler } from '../../sync/src/index.js';
// Electron 真实挂载函数（registerInstalledModules 内部调用同一个纯函数）：
import { registerHttpRoutes } from '../../electron/src/server.js';

let testDir: string;
let cliServer: http.Server;
let cliBase: string;
let electronServer: http.Server;
let electronBase: string;

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-wiring-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();

  const db = getConnection();
  // 测试项目，供 sync config 外键引用（与 sync-routes.test 一致）
  db.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run(
    'wiring-test',
    path.join(testDir, 'proj'),
  );

  // ───────────────────────────────────────────────────────────────────────
  // A) CLI 挂载序列 —— 复刻 doc77.ts:305-414
  // ───────────────────────────────────────────────────────────────────────
  const cliApp = createApp();

  // T8: sync routes（sync engine + scheduler）
  const syncEngine = createSyncEngine();
  const getProjectPath = (pid: number): string | null => {
    const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as
      { path: string } | undefined;
    return row?.path || null;
  };
  const syncScheduler = createSyncScheduler({ engine: syncEngine, db, getProjectPath });
  registerSyncRoutes(cliApp, { engine: syncEngine, scheduler: syncScheduler, db, getProjectPath });

  // T10: RAG routes（真实 RagEngine + mock 嵌入函数，与 rag.test 一致）
  const mockEmbed = async (texts: string[]): Promise<number[][]> => {
    return texts.map((t) => {
      const vec = new Array(8).fill(0);
      for (const ch of t.toLowerCase()) vec[ch.charCodeAt(0) % 8] += 1;
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  };
  const ragEngine = new RagEngine({
    db,
    config: {
      embedder: { provider: 'custom', embedModel: 'mock' },
      chunkOptions: { minChunkSize: 1 },
    },
    embedFn: mockEmbed,
  });
  registerAiRagRoutes(cliApp, { engine: ragEngine, db });

  // T11: plugin routes
  registerPluginRoutes(cliApp, { db, pluginDir: path.join(testDir, 'plugins') });

  // 注：/api/tunnel/config 与 /api/ai/providers 已在 createApp() 内注册（core 内置）。
  //     AI/MCP 可选块在测试环境无对应模块，故省略，不影响上述 5 条路由断言。

  cliServer = http.createServer(cliApp);
  await new Promise<void>((resolve) => cliServer.listen(0, resolve));
  const cliAddr = cliServer.address() as { port: number };
  cliBase = `http://127.0.0.1:${cliAddr.port}`;

  // ───────────────────────────────────────────────────────────────────────
  // B) Electron 挂载 —— 调用 server.ts 导出的真实挂载函数 registerHttpRoutes
  //    （registerInstalledModules 内部使用同一函数），补挂 sync/rag/plugin。
  // ───────────────────────────────────────────────────────────────────────
  const electronApp = createApp();
  let galleryModule:
    { registerGalleryRoutes: (app: any, deps: any) => Promise<unknown> } | undefined;
  try {
    const gallery = await import('@doc77/gallery');
    if (gallery?.registerGalleryRoutes) {
      galleryModule = { registerGalleryRoutes: gallery.registerGalleryRoutes };
    }
  } catch {
    /* gallery 不可用时静默降级，与 Electron 行为一致 */
  }
  // 真实挂载函数：与 Electron 运行时完全一致（模块对象由调用方注入）
  await registerHttpRoutes(electronApp, {
    getConnection,
    getConfig: () => undefined,
    thumbnailsDir: path.join(testDir, 'thumbs'),
    pluginDir: path.join(testDir, 'plugins'),
    sync: { createSyncEngine, createSyncScheduler, registerSyncRoutes },
    rag: { RagEngine, registerAiRagRoutes, embedFn: mockEmbed },
    plugins: { registerPluginRoutes },
    gallery: galleryModule,
  });

  electronServer = http.createServer(electronApp);
  await new Promise<void>((resolve) => electronServer.listen(0, resolve));
  const elAddr = electronServer.address() as { port: number };
  electronBase = `http://127.0.0.1:${elAddr.port}`;
});

afterAll(() => {
  cliServer?.close();
  electronServer?.close();
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// A) CLI 接线实证
// ─────────────────────────────────────────────────────────────────────────
describe('A) CLI 接线实证 — 真实服务器 + 真实 fetch（预期 200）', () => {
  it('GET /api/ai/providers → 200 (core 内置路由)', async () => {
    const res = await fetch(`${cliBase}/api/ai/providers`);
    console.log('[CLI] GET /api/ai/providers ->', res.status);
    expect(res.status).toBe(200);
  });

  it('GET /api/tunnel/config → 200 (core 内置路由)', async () => {
    const res = await fetch(`${cliBase}/api/tunnel/config`);
    console.log('[CLI] GET /api/tunnel/config ->', res.status);
    expect(res.status).toBe(200);
  });

  it('GET /api/sync/configs/1 → 200 (T8 registerSyncRoutes)', async () => {
    // 先 PUT 配置使该路由返回 200（复刻 sync-routes.test 的 round-trip）
    const putRes = await fetch(`${cliBase}/api/sync/configs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapter_type: 'local',
        config_json: JSON.stringify({
          type: 'local',
          targetPath: path.join(testDir, 'sync-target'),
        }),
        direction: 'push',
        interval_seconds: 0,
        enabled: 1,
      }),
    });
    expect(putRes.status).toBe(200);
    const res = await fetch(`${cliBase}/api/sync/configs/1`);
    console.log('[CLI] GET /api/sync/configs/1 ->', res.status);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { adapter_type: string } };
    expect(body.config.adapter_type).toBe('local');
  });

  it('POST /api/ai/rag/index → 200 (T10 registerAiRagRoutes)', async () => {
    const res = await fetch(`${cliBase}/api/ai/rag/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 1,
        file_path: 'wiring.md',
        content: '接线回归测试文档。\n\n第二段内容用于分块索引。',
      }),
    });
    console.log('[CLI] POST /api/ai/rag/index ->', res.status);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; chunkCount: number };
    expect(body.ok).toBe(true);
    expect(body.chunkCount).toBeGreaterThan(0);
  });

  it('POST /api/plugins/install → 200 (T11 registerPluginRoutes)', async () => {
    const res = await fetch(`${cliBase}/api/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wiring-demo', version: '1.0.0', type: 'renderer' }),
    });
    console.log('[CLI] POST /api/plugins/install ->', res.status);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// B) Electron 接线实证（修复后：真实 registerHttpRoutes 挂载，预期 200）
// ─────────────────────────────────────────────────────────────────────────
describe('B) Electron 接线实证 — 真实 registerHttpRoutes（预期 200）', () => {
  it('server 在线（GET /api/ai/providers → 200，证明服务已启动）', async () => {
    const res = await fetch(`${electronBase}/api/ai/providers`);
    console.log('[ELN] GET /api/ai/providers ->', res.status);
    expect(res.status).toBe(200);
  });

  it('GET /api/sync/configs/1 → 200（Electron 已挂 registerSyncRoutes）', async () => {
    // 先 PUT 配置再 GET（复刻 sync-routes.test 的 round-trip）
    const putRes = await fetch(`${electronBase}/api/sync/configs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapter_type: 'local',
        config_json: JSON.stringify({
          type: 'local',
          targetPath: path.join(testDir, 'eln-sync-target'),
        }),
        direction: 'push',
        interval_seconds: 0,
        enabled: 1,
      }),
    });
    expect(putRes.status).toBe(200);
    const res = await fetch(`${electronBase}/api/sync/configs/1`);
    console.log('[ELN] GET /api/sync/configs/1 ->', res.status);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { adapter_type: string } };
    expect(body.config.adapter_type).toBe('local');
  });

  it('POST /api/ai/rag/index → 200（Electron 已挂 registerAiRagRoutes）', async () => {
    const res = await fetch(`${electronBase}/api/ai/rag/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 1,
        file_path: 'eln-wiring.md',
        content: 'Electron 接线回归测试文档。\n\n第二段内容用于分块索引。',
      }),
    });
    console.log('[ELN] POST /api/ai/rag/index ->', res.status);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; chunkCount: number };
    expect(body.ok).toBe(true);
    expect(body.chunkCount).toBeGreaterThan(0);
  });

  it('POST /api/plugins/install → 200（Electron 已挂 registerPluginRoutes）', async () => {
    const res = await fetch(`${electronBase}/api/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'eln-wiring-demo', version: '1.0.0', type: 'renderer' }),
    });
    console.log('[ELN] POST /api/plugins/install ->', res.status);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
