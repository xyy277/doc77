import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';
import { getEventBus, resetEventBus } from '../src/server/event-bus.js';
import { stopFileWatcher } from '../src/server/watcher.js';
import {
  setupPasswordWithDEK,
  createTunnelSession,
  issueSessionToken,
} from '../src/server/auth.js';
import { getTunnelManager } from '../src/tunnel/manager.js';

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

/**
 * SSE 认证 — 隧道分支（独立验证 Phase 2）。
 * 覆盖 sse-auth.test.ts 未测的 tunnel-running 路径，以及 XFF 信任边界
 * 修复的回归（首条 XFF 伪造 → 应取代理追加的末条真实 IP）。
 */
describe('SSE auth — tunnel branch + XFF trust', () => {
  let testDir: string;
  let mgr: ReturnType<typeof getTunnelManager>;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-sse-tunnel-'));
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    resetEventBus();
    mgr = getTunnelManager();
    mgr.__setStatusForTest('running'); // 隧道 running：非 localhost 强制认证
  });

  afterEach(async () => {
    stopFileWatcher();
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const XFF_REMOTE = '203.0.113.9';

  it('非 localhost + 有效 tunnel session ?token= → 200 并收到事件流', async () => {
    const token = createTunnelSession();
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`, {
        headers: { 'X-Forwarded-For': XFF_REMOTE },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const controller = new AbortController();
      try {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const readPromise = (async () => {
          let acc = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            acc += decoder.decode(value, { stream: true });
            if (acc.includes('graph:index-progress')) return acc;
          }
          return acc;
        })();
        getEventBus().emit('graph:index-progress', { projectId: 1, total: 100, processed: 40 });
        const streamed = await Promise.race([
          readPromise,
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('SSE stream timeout')), 3000),
          ),
        ]);
        expect(streamed).toContain('graph:index-progress');
        expect(streamed).toContain('40');
      } finally {
        controller.abort();
      }
    });
  });

  it('非 localhost + 有效常规 session ?token= → 200（两 store 都认）', async () => {
    const token = issueSessionToken();
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`, {
        headers: { 'X-Forwarded-For': XFF_REMOTE },
      });
      expect(res.status).toBe(200);
      res.body?.cancel();
    });
  });

  it('非 localhost + 无 token → 401 tunnelActive:true', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events`, {
        headers: { 'X-Forwarded-For': XFF_REMOTE },
      });
      expect(res.status).toBe(401);
      const d = (await res.json()) as { code?: string; tunnelActive?: boolean };
      expect(d.code).toBe('AUTH_REQUIRED');
      expect(d.tunnelActive).toBe(true);
    });
  });

  it('非 localhost + 垃圾 token → 401', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events?token=garbage`, {
        headers: { 'X-Forwarded-For': XFF_REMOTE },
      });
      expect(res.status).toBe(401);
    });
  });

  it('localhost XFF + open mode 无 token → 200（门控跳过）', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events`, {
        headers: { 'X-Forwarded-For': '127.0.0.1' },
      });
      expect(res.status).toBe(200);
      res.body?.cancel();
    });
  });

  it('XFF 信任边界：open mode 下伪造首条 127.0.0.1 不得冒充 localhost（取代理追加的末条）', async () => {
    // 漏洞复现路径：open mode（无密码）+ 隧道 running + 伪造 XFF 首条 127.0.0.1
    // （模拟 cloudflared 透传：客户端伪造首条，代理追加真实 IP 到末条）。
    // 修复前信任首条 → 200（漏洞：远程未认证全量访问）；修复后取末条 → 非 localhost → 401。
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events`, {
        headers: { 'X-Forwarded-For': `127.0.0.1, ${XFF_REMOTE}` },
      });
      expect(res.status).toBe(401);
    });
  });

  it('XFF 信任边界：末条非 localhost 的隧道转发请求必须认证（含 password 模式）', async () => {
    setupPasswordWithDEK('test-password');
    const token = issueSessionToken();
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      // 无 token：末条 8.8.8.8 → 非 localhost → 401
      const noToken = await fetch(`${baseUrl}/api/events`, {
        headers: { 'X-Forwarded-For': `${XFF_REMOTE}, 8.8.8.8` },
      });
      expect(noToken.status).toBe(401);
      // 带有效 token：放行
      const withToken = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`, {
        headers: { 'X-Forwarded-For': `${XFF_REMOTE}, 8.8.8.8` },
      });
      expect(withToken.status).toBe(200);
      withToken.body?.cancel();
    });
  });

  it('隧道分支窄范围：/api/projects?token= 仍 401', async () => {
    setupPasswordWithDEK('test-password');
    const token = issueSessionToken();
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/projects?token=${encodeURIComponent(token)}`, {
        headers: { 'X-Forwarded-For': XFF_REMOTE },
      });
      expect(res.status).toBe(401);
    });
  });

  it('readonly 策略：非 localhost 写操作 → 403 TUNNEL_READONLY；localhost XFF 不触发', async () => {
    const db = (await import('../src/db/config.js')) as typeof import('../src/db/config.js');
    db.setConfig('tunnel.access_policy', 'readonly');
    const token = createTunnelSession();
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const remote = await fetch(`${baseUrl}/api/graph/1/index`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Forwarded-For': XFF_REMOTE,
        },
      });
      expect(remote.status).toBe(403);
      const d = (await remote.json()) as { code?: string };
      expect(d.code).toBe('TUNNEL_READONLY');

      const local = await fetch(`${baseUrl}/api/graph/1/index`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Forwarded-For': '127.0.0.1',
        },
      });
      expect(local.status).not.toBe(403);
    });
  });
});
