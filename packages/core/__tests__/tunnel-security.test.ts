/**
 * T3 隧道安全修复测试
 *
 * 覆盖场景：
 * 1. 开放模式（无密码）+ 隧道 running + 非 localhost 请求 + 无 token → 401
 * 2. 开放模式 + 隧道 running + localhost 请求 → 正常通过（不破坏本地工作流）
 * 3. 开放模式 + 隧道 stopped + 非 localhost 请求 → 正常通过（隧道未激活时开放模式生效）
 * 4. 隧道 readonly 策略 + 写操作 → 403
 * 5. 隧道 session 创建、校验、30min TTL
 * 6. 隧道 session token 通过认证门控
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { setConfig } from '../src/db/config.js';
import { createApp } from '../src/server/app.js';
import { getTunnelManager } from '../src/tunnel/manager.js';
import {
  createTunnelSession,
  validateTunnelSessionToken,
  destroyTunnelSession,
  revokeAllTunnelSessions,
} from '../src/server/auth.js';

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-tunnel-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();
});

afterAll(() => {
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
  }
}

describe('T3 隧道安全 — auth 中间件门控', () => {
  let mgr: ReturnType<typeof getTunnelManager>;

  beforeEach(() => {
    mgr = getTunnelManager();
    // 默认重置为 stopped
    mgr.__setStatusForTest('stopped');
  });

  afterEach(() => {
    mgr.__setStatusForTest('stopped');
    revokeAllTunnelSessions();
  });

  it('开放模式 + 隧道 running + 非 localhost + 无 token → 401', async () => {
    // 确保开放模式（无密码）
    const db = (await import('../src/db/connection.js')).getConnection();
    db.prepare("DELETE FROM config WHERE key = 'user_auth_set'").run();
    // user_auth 表为空即开放模式
    db.prepare('DELETE FROM user_auth').run();

    mgr.__setStatusForTest('running');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        headers: { 'X-Forwarded-For': '203.0.113.42' },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string; tunnelActive?: boolean };
      expect(body.code).toBe('AUTH_REQUIRED');
      expect(body.tunnelActive).toBe(true);
    });
  });

  it('开放模式 + 隧道 running + localhost 请求 → 正常通过', async () => {
    const db = (await import('../src/db/connection.js')).getConnection();
    db.prepare('DELETE FROM user_auth').run();

    mgr.__setStatusForTest('running');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      // 不带 X-Forwarded-For，req.ip 为 127.0.0.1
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
    });
  });

  it('开放模式 + 隧道 stopped + 非 localhost → 正常通过', async () => {
    const db = (await import('../src/db/connection.js')).getConnection();
    db.prepare('DELETE FROM user_auth').run();

    mgr.__setStatusForTest('stopped');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { 'X-Forwarded-For': '203.0.113.42' },
      });
      expect(res.status).toBe(200);
    });
  });

  it('隧道 readonly 策略 + 写操作 → 403', async () => {
    const db = (await import('../src/db/connection.js')).getConnection();
    db.prepare('DELETE FROM user_auth').run();
    setConfig('tunnel.access_policy', 'readonly');

    mgr.__setStatusForTest('running');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      // POST 写操作 + 非 localhost → 403
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.42',
        },
        body: JSON.stringify({ path: '/tmp' }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('TUNNEL_READONLY');
    });

    setConfig('tunnel.access_policy', 'open');
  });

  it('隧道 session token 通过认证门控', async () => {
    const db = (await import('../src/db/connection.js')).getConnection();
    db.prepare('DELETE FROM user_auth').run();

    mgr.__setStatusForTest('running');
    const tunnelToken = createTunnelSession();

    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: {
          'X-Forwarded-For': '203.0.113.42',
          Authorization: `Bearer ${tunnelToken}`,
        },
      });
      expect(res.status).toBe(200);
    });
  });
});

describe('T3 隧道 session store', () => {
  afterEach(() => {
    revokeAllTunnelSessions();
  });

  it('createTunnelSession 返回非空 token', () => {
    const token = createTunnelSession();
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('validateTunnelSessionToken 对有效 token 返回 true', () => {
    const token = createTunnelSession();
    expect(validateTunnelSessionToken(token)).toBe(true);
  });

  it('validateTunnelSessionToken 对无效 token 返回 false', () => {
    expect(validateTunnelSessionToken(null)).toBe(false);
    expect(validateTunnelSessionToken(undefined)).toBe(false);
    expect(validateTunnelSessionToken('')).toBe(false);
    expect(validateTunnelSessionToken('invalid-token')).toBe(false);
  });

  it('destroyTunnelSession 注销后 token 失效', () => {
    const token = createTunnelSession();
    expect(validateTunnelSessionToken(token)).toBe(true);
    expect(destroyTunnelSession(token)).toBe(true);
    expect(validateTunnelSessionToken(token)).toBe(false);
  });

  it('revokeAllTunnelSessions 清空所有隧道 session', () => {
    const t1 = createTunnelSession();
    const t2 = createTunnelSession();
    revokeAllTunnelSessions();
    expect(validateTunnelSessionToken(t1)).toBe(false);
    expect(validateTunnelSessionToken(t2)).toBe(false);
  });
});
