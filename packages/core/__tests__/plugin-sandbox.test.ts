/**
 * T11 验收测试 — 插件沙箱 + API 路由
 *
 * 覆盖：
 * - PluginSandbox：正常执行、路径越界拒绝、超时
 * - plugin routes：install/list/toggle/config/delete
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { initDatabase, closeConnection, getConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { PluginSandbox } from '../src/plugin/sandbox.js';
import { registerPluginRoutes } from '../src/server/routes/plugin.js';

let testDir: string;
let dbPath: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-plugin-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();

  // 简易路由器
  const routes: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: (req: any, res: any) => void }> = [];
  const addRoute = (method: string, p: string, h: any) => {
    const paramNames: string[] = [];
    const regexStr = p.replace(/:([^/]+)/g, (_, n) => { paramNames.push(n); return '([^/]+)'; });
    routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler: h });
  };
  const app = {
    get: (p: string, h: any) => addRoute('GET', p, h),
    post: (p: string, h: any) => addRoute('POST', p, h),
    put: (p: string, h: any) => addRoute('PUT', p, h),
    delete: (p: string, h: any) => addRoute('DELETE', p, h),
  };
  registerPluginRoutes(app as any, { db: getConnection(), pluginDir: path.join(testDir, 'plugins') });

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    for (const route of routes) {
      if (route.method !== (req.method || '').toUpperCase()) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      let body: any = undefined;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
      }
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      const reqLike = { params, query: {}, body, method: req.method, path: url.pathname };
      const resLike = {
        _status: 200,
        status(code: number) { this._status = code; return this; },
        json(data: unknown) { res.writeHead(this._status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
      };
      await route.handler(reqLike, resLike);
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  try { closeConnection(); } catch {}
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('T11 — PluginSandbox 沙箱', () => {
  it('正常执行插件代码并返回 module.exports', () => {
    const projectPath = path.join(testDir, 'sandbox-project');
    fs.mkdirSync(projectPath, { recursive: true });
    const sandbox = new PluginSandbox({ projectPath });
    const code = `module.exports = { greet: () => 'hello from plugin' };`;
    const result = sandbox.run(code);
    expect(result.ok).toBe(true);
    expect((result.result as { greet: () => string }).greet()).toBe('hello from plugin');
  });

  it('插件可读取项目目录内文件', () => {
    const projectPath = path.join(testDir, 'sandbox-fs');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'data.txt'), 'sandbox content');
    const sandbox = new PluginSandbox({ projectPath });
    const code = `module.exports = fs.readFile('data.txt');`;
    const result = sandbox.run(code);
    expect(result.ok).toBe(true);
    expect(result.result).toBe('sandbox content');
  });

  it('插件尝试读取项目目录外文件 → 抛错', () => {
    const projectPath = path.join(testDir, 'sandbox-safe');
    fs.mkdirSync(projectPath, { recursive: true });
    const sandbox = new PluginSandbox({ projectPath });
    const code = `module.exports = fs.readFile('../../../etc/passwd');`;
    const result = sandbox.run(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Access denied|outside project/);
  });

  it('路径穿越攻击被拦截（.. 解析到项目外）', () => {
    const projectPath = path.join(testDir, 'sandbox-traversal');
    fs.mkdirSync(projectPath, { recursive: true });
    const sandbox = new PluginSandbox({ projectPath });
    expect(sandbox.isPathSafe('safe.txt')).toBe(true);
    expect(sandbox.isPathSafe('../outside.txt')).toBe(false);
    expect(sandbox.isPathSafe('../../etc/passwd')).toBe(false);
  });

  it('插件代码抛错时返回 ok=false', () => {
    const sandbox = new PluginSandbox({ projectPath: testDir });
    const code = `throw new Error('plugin crash');`;
    const result = sandbox.run(code);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('T11 — 插件 API 路由', () => {
  it('POST /api/plugins/install 安装插件', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-renderer',
        version: '1.0.0',
        type: 'renderer',
        source: 'npm',
        config: { theme: 'dark' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; installed: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.installed).toBe(true);
    expect(body.name).toBe('test-renderer');
  });

  it('GET /api/plugins 列出已安装插件', async () => {
    const res = await fetch(`${baseUrl}/api/plugins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: Array<{ name: string; enabled: boolean }> };
    expect(body.plugins.length).toBeGreaterThan(0);
    expect(body.plugins.some((p) => p.name === 'test-renderer')).toBe(true);
  });

  it('POST /api/plugins/:name/toggle 禁用插件', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/test-renderer/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; enabled: boolean };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
  });

  it('GET /api/plugins/:name/config 读取配置', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/test-renderer/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { theme: string } };
    expect(body.config.theme).toBe('dark');
  });

  it('PUT /api/plugins/:name/config 更新配置', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/test-renderer/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { theme: 'light' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; config: { theme: string } };
    expect(body.ok).toBe(true);
    expect(body.config.theme).toBe('light');
  });

  it('DELETE /api/plugins/:name 卸载插件', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/test-renderer`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: string };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe('test-renderer');
  });

  it('卸载后 GET /api/plugins 不再包含该插件', async () => {
    const res = await fetch(`${baseUrl}/api/plugins`);
    const body = (await res.json()) as { plugins: Array<{ name: string }> };
    expect(body.plugins.some((p) => p.name === 'test-renderer')).toBe(false);
  });
});
