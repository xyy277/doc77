import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';
import { getLocale } from '../src/i18n/index.js';

const TEST_DB = path.join(os.tmpdir(), 'doc77-test-i18n-config-' + Date.now() + '.db');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await initDatabase(TEST_DB);
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
  try {
    fs.unlinkSync(TEST_DB);
  } catch {}
});

describe('PUT /api/config locale.language re-initializes backend i18n', () => {
  it('switches backend locale immediately without restart', async () => {
    const put = async (value: string) => {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'locale.language', value }),
      });
      expect(res.status).toBe(200);
    };

    await put('en-US');
    expect(getLocale()).toBe('en-US');

    await put('zh-CN');
    expect(getLocale()).toBe('zh-CN');
  });

  it('does not touch i18n for unrelated config keys', async () => {
    const before = getLocale();
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'editor.default', value: 'vscode' }),
    });
    expect(res.status).toBe(200);
    expect(getLocale()).toBe(before);
  });
});
