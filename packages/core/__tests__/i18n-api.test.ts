import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { buildI18nResponse } from '../src/server/i18n-route.js';
import { initI18n } from '../src/i18n/index.js';
import { createApp } from '../src/server/app.js';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';

describe('buildI18nResponse', () => {
  it('explicit lang wins over global and hint', () => {
    initI18n('');
    const r = buildI18nResponse({ lang: 'zh-CN', hint: 'en-US', global: 'en-US' });
    expect(r.lang).toBe('zh-CN');
    expect(r.dict['test.hello']).toBe('你好');
    expect(r.global).toBe('en-US');
    expect(r.available.some((l) => l.code === 'en-US')).toBe(true);
  });

  it('falls back: no lang → global → hint', () => {
    initI18n('');
    expect(buildI18nResponse({ lang: '', hint: 'zh', global: '' }).lang).toBe('zh-CN');
    expect(buildI18nResponse({ lang: '', hint: '', global: 'en-US' }).lang).toBe('en-US');
  });

  it('etag is stable for same dict and changes across langs', () => {
    initI18n('');
    const a = buildI18nResponse({ lang: 'zh-CN', hint: '', global: '' });
    const b = buildI18nResponse({ lang: 'zh-CN', hint: '', global: '' });
    const c = buildI18nResponse({ lang: 'en-US', hint: '', global: '' });
    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(c.etag);
  });
});

describe('GET /api/i18n HTTP contract', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    await initDatabase(path.join(os.tmpdir(), 'doc77-test-i18n-http-' + Date.now() + '.db'));
    runMigrations();
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
    closeConnection();
  });

  it('serves a non-empty dict and forbids browser caching (no-store)', async () => {
    const res = await fetch(`${baseUrl}/api/i18n`);
    expect(res.status).toBe(200);
    // Regression guard: a browser-cached ETag would make the server answer
    // 304 with an empty body; the frontend r.json() then rejects and every
    // label renders as its raw key. no-store prevents that path entirely.
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as { dict: Record<string, string> };
    expect(Object.keys(body.dict).length).toBeGreaterThan(0);
    // No lang param → resolves to en-US fallback; dict must be populated.
    expect(body.dict['test.hello']).toBe('Hello');
    // zh 请求也应命中中文词条
    const zh = (await (await fetch(`${baseUrl}/api/i18n?lang=zh-CN`)).json()) as {
      dict: Record<string, string>;
    };
    expect(zh.dict['test.hello']).toBe('你好');
  });
});
