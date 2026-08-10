/**
 * T8 验收测试 — 同步路由 + scheduler
 *
 * 覆盖验收标准：
 * - PUT 配置 → GET 返回一致
 * - POST test 测试连接
 * - POST run 立即同步 → pushed > 0
 * - GET /api/sync/configs/:id 返回 200（此前为 404）
 * - scheduler start/stop
 *
 * 测试范式：纯 http.createServer + 手动路由匹配（不依赖 express）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { initDatabase, closeConnection, runMigrations, getConnection } from '@doc77/core';
import { createSyncEngine, registerSyncRoutes, createSyncScheduler } from '../src/index.js';
import type { AppRouter, RequestLike, ResponseLike } from '../src/routes.js';

let testDir: string;
let dbPath: string;
let server: http.Server;
let baseUrl: string;

/**
 * 简易路由器：模拟 Express 的 get/post/put。
 * 把路由存到数组，在 http server 中按 method+path 匹配。
 */
function createSimpleApp(): AppRouter & { handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> } {
  const routes: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: (req: RequestLike, res: ResponseLike) => void }> = [];

  const addRoute = (method: string, pathStr: string, handler: (req: RequestLike, res: ResponseLike) => void) => {
    // 将 :param 转为正则捕获组
    const paramNames: string[] = [];
    const regexStr = pathStr.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler });
  };

  return {
    get: (p, h) => addRoute('GET', p, h),
    post: (p, h) => addRoute('POST', p, h),
    put: (p, h) => addRoute('PUT', p, h),
    handle: async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(pathname);
        if (!match) continue;

        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });

        // 解析 body（POST/PUT）
        let body: unknown = undefined;
        if (method === 'POST' || method === 'PUT') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }

        const query: Record<string, unknown> = {};
        url.searchParams.forEach((v, k) => { query[k] = v; });

        const reqLike: RequestLike = { params, query, body, method, path: pathname };
        // `_status` 是运行时私有字段（非 ResponseLike 接口成员），
        // 不在对象字面量中初始化 —— json() 在未 set 时默认回退 200，行为不变。
        const resLike: ResponseLike & { _status?: number } = {
          status(code) { (this as unknown as { _status?: number })._status = code; return this; },
          json(data) {
            const code = (this as unknown as { _status: number })._status || 200;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
          },
        };

        await route.handler(reqLike, resLike as ResponseLike);
        return true;
      }
      return false;
    },
  };
}

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-sync-routes-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();

  // 创建一个测试项目（sync_configs 外键引用 projects）
  const projectPath = path.join(testDir, 'my-project');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'file1.md'), '# Hello');
  fs.writeFileSync(path.join(projectPath, 'file2.md'), '# World');
  const db = getConnection();
  db.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run('test-project', projectPath);

  const engine = createSyncEngine();
  const scheduler = createSyncScheduler({
    engine,
    db,
    getProjectPath: (pid: number) => {
      const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as
        | { path: string }
        | undefined;
      return row?.path || null;
    },
  });

  const app = createSimpleApp();
  registerSyncRoutes(app, {
    engine,
    scheduler,
    db,
    getProjectPath: (pid: number) => {
      const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as
        | { path: string }
        | undefined;
      return row?.path || null;
    },
  });

  await new Promise<void>((resolve) => {
    server = http.createServer(async (req, res) => {
      const handled = await app.handle(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('Not Found');
      }
    }).listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('T8 — 同步路由', () => {
  it('GET /api/sync/configs/1 无配置时返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/sync/configs/1`);
    expect(res.status).toBe(404);
  });

  it('PUT 配置后 GET 返回一致', async () => {
    const config = {
      adapter_type: 'local',
      config_json: JSON.stringify({
        type: 'local',
        targetPath: path.join(testDir, 'sync-target'),
      }),
      direction: 'push',
      interval_seconds: 0,
      enabled: 1,
    };
    const putRes = await fetch(`${baseUrl}/api/sync/configs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { config: { adapter_type: string } };
    expect(putBody.config.adapter_type).toBe('local');

    const getRes = await fetch(`${baseUrl}/api/sync/configs/1`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { config: { adapter_type: string; direction: string } };
    expect(getBody.config.adapter_type).toBe('local');
    expect(getBody.config.direction).toBe('push');
  });

  it('POST /api/sync/test 测试 local 适配器连接', async () => {
    const res = await fetch(`${baseUrl}/api/sync/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapter_type: 'local',
        config_json: JSON.stringify({
          type: 'local',
          targetPath: path.join(testDir, 'sync-target'),
        }),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('POST /api/sync/run/1 立即同步 → pushed > 0', async () => {
    const res = await fetch(`${baseUrl}/api/sync/run/1`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { status: string; pushed: number; pulled: number };
    };
    expect(body.result.status).toBe('success');
    expect(body.result.pushed).toBeGreaterThan(0);
  });

  it('GET /api/sync/state/1 返回同步状态', async () => {
    const res = await fetch(`${baseUrl}/api/sync/state/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { status: string; total_pushed: number } | null;
      schedulerRunning: boolean;
    };
    expect(body.state).not.toBeNull();
    expect(body.state!.total_pushed).toBeGreaterThan(0);
    expect(body.schedulerRunning).toBe(false);
  });

  it('GET /api/sync/log/1 返回同步日志', async () => {
    const res = await fetch(`${baseUrl}/api/sync/log/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: Array<{ files_pushed: number }> };
    expect(body.logs.length).toBeGreaterThan(0);
    expect(body.logs[0].files_pushed).toBeGreaterThan(0);
  });

  it('scheduler start/stop 切换运行状态', async () => {
    // start（interval_seconds=0 不会真正启动定时器，但 API 仍返回 running=true）
    // 改用 interval_seconds>0 的配置测试
    await fetch(`${baseUrl}/api/sync/configs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapter_type: 'local',
        config_json: JSON.stringify({
          type: 'local',
          targetPath: path.join(testDir, 'sync-target'),
        }),
        direction: 'push',
        interval_seconds: 3600,
        enabled: 1,
      }),
    });
    const startRes = await fetch(`${baseUrl}/api/sync/scheduler/1/start`, { method: 'POST' });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as { running: boolean };
    expect(startBody.running).toBe(true);

    // 验证 state 中 schedulerRunning=true
    const stateRes = await fetch(`${baseUrl}/api/sync/state/1`);
    const stateBody = (await stateRes.json()) as { schedulerRunning: boolean };
    expect(stateBody.schedulerRunning).toBe(true);

    // stop
    const stopRes = await fetch(`${baseUrl}/api/sync/scheduler/1/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
    const stopBody = (await stopRes.json()) as { running: boolean };
    expect(stopBody.running).toBe(false);
  });
});
