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
import { setupPasswordWithDEK, issueSessionToken } from '../src/server/auth.js';
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
 * SSE 认证：/api/events 接受 ?token= 查询参数（EventSource 无法携带
 * Authorization header）。窄范围：query token 仅对 /api/events 生效，
 * 其他 /api 路由仍只认 header。
 */
describe('SSE auth (?token= on /api/events)', () => {
  let testDir: string;
  let mgr: ReturnType<typeof getTunnelManager>;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-sse-auth-'));
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    resetEventBus(); // 隔离全局事件总线，避免测试间事件串扰
    mgr = getTunnelManager();
    mgr.__setStatusForTest('stopped'); // 关闭隧道分支，聚焦密码门控
  });

  afterEach(async () => {
    // SSE 用例会经 /api/events 惰性启动真实 chokidar，必须清理防跨用例残留
    stopFileWatcher();
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 设密后经真实 HTTP 登录拿 session token（黑盒路径，限速 5/min 内） */
  async function loginToken(baseUrl: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { ok: boolean; token?: string };
    expect(d.ok).toBe(true);
    return d.token!;
  }

  /** 读取 SSE 流直到出现目标事件名（3s 超时） */
  async function readUntilEvent(res: Response, marker: string): Promise<string> {
    const controller = new AbortController();
    try {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          if (acc.includes(marker)) return acc;
        }
        return acc;
      })();
      return await Promise.race([
        readPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('SSE stream timeout')), 3000),
        ),
      ]);
    } finally {
      controller.abort();
    }
  }

  it('open mode（未设密）：/api/events 无 token 直连 200（回归守卫）', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      res.body?.cancel();
    });
  });

  it('设密后无 token：/api/events → 401 AUTH_REQUIRED', async () => {
    setupPasswordWithDEK('test-password');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events`);
      expect(res.status).toBe(401);
      const d = (await res.json()) as { code?: string; tunnelActive?: boolean };
      expect(d.code).toBe('AUTH_REQUIRED');
      expect(d.tunnelActive).toBeUndefined(); // 密码分支响应形状（非隧道）
    });
  });

  it('设密 + 有效 ?token=：连接建立并收到事件流', async () => {
    setupPasswordWithDEK('test-password');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      // 连接打开后触发事件，读取流应包含该事件（api.test.ts 同款模式）
      const streamedPromise = readUntilEvent(res, 'file-tree:changed');
      getEventBus().emit('file-tree:changed', {
        projectId: 1,
        path: '',
        opType: 'modify',
        paths: ['README.md'],
      });
      const streamed = await streamedPromise;
      expect(streamed).toContain('file-tree:changed');
      expect(streamed).toContain('README.md');
    });
  });

  it('设密 + 垃圾 token：/api/events?token=garbage → 401', async () => {
    setupPasswordWithDEK('test-password');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/events?token=garbage`);
      expect(res.status).toBe(401);
    });
  });

  it('窄范围：有效 token 经 ?token= 不得解锁其他 /api 路由', async () => {
    setupPasswordWithDEK('test-password');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const token = issueSessionToken(); // 同一 session store，不耗登录限速
      const res = await fetch(`${baseUrl}/api/projects?token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(401);
    });
  });

  it('回归：Authorization header 方式在 /api/events 仍可用', async () => {
    setupPasswordWithDEK('test-password');
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const token = issueSessionToken();
      const res = await fetch(`${baseUrl}/api/events`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      res.body?.cancel();
    });
  });
});
