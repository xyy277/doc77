import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
 * Integration tests for device-aware routing.
 *
 * These tests run against the REAL src/web/ directory (including the mobile/ stubs).
 * The server resolves webDir from moduleDir (src/server/) → candidate #2 → src/web/.
 */
describe('Mobile Routing — Integration', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-mobile-routing-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── GET / ──

  describe('GET /', () => {
    it('desktop UA → desktop index.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/', { headers: { 'User-Agent': DESKTOP_UA } });
        expect(res.status).toBe(200);
        const html = await res.text();
        // Desktop index.html has project-registration form elements
        expect(html).toContain('Doc77');
        expect(html).toContain('id="projGrid"');
      });
    });

    it('iPhone UA → mobile/index.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/', { headers: { 'User-Agent': IPHONE_UA } });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('bottom-nav');
      });
    });

    it('Android UA → mobile/index.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/', { headers: { 'User-Agent': ANDROID_UA } });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('bottom-nav');
      });
    });

    it('no User-Agent → desktop index.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/');
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('Doc77');
        expect(html).toContain('id="projGrid"');
      });
    });
  });

  // ── GET /preview.html ──

  describe('GET /preview.html', () => {
    it('desktop UA → desktop preview.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/preview.html', {
          headers: { 'User-Agent': DESKTOP_UA },
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('leftPanel'); // unique to desktop preview layout
      });
    });

    it('iPhone UA → mobile/preview.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/preview.html', {
          headers: { 'User-Agent': IPHONE_UA },
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('breadcrumb'); // unique to mobile preview
        expect(html).not.toContain('leftPanel'); // unique to desktop
      });
    });

    it('Android UA → mobile/preview.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/preview.html', {
          headers: { 'User-Agent': ANDROID_UA },
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('breadcrumb');
      });
    });
  });

  // ── Cookie override ──

  describe('Cookie: doc77-desktop=1 overrides UA detection', () => {
    it('iPhone + cookie → desktop index.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/', {
          headers: {
            'User-Agent': IPHONE_UA,
            Cookie: 'doc77-desktop=1',
          },
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('id="projGrid"'); // desktop marker
      });
    });

    it('iPhone + cookie → desktop preview.html', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/preview.html', {
          headers: {
            'User-Agent': IPHONE_UA,
            Cookie: 'doc77-desktop=1',
          },
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('leftPanel'); // desktop marker
      });
    });

    it('iPhone + cookie=0 → still mobile', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/', {
          headers: {
            'User-Agent': IPHONE_UA,
            Cookie: 'doc77-desktop=0',
          },
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('bottom-nav');
      });
    });
  });

  // ── Explicit /mobile/ path ──

  describe('GET /mobile/ (explicit path — always serves mobile)', () => {
    it('desktop browser → /mobile/ returns mobile', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/mobile/', { headers: { 'User-Agent': DESKTOP_UA } });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('bottom-nav');
      });
    });

    it('/mobile (no trailing slash) → redirects to /mobile/', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/mobile', {
          headers: { 'User-Agent': DESKTOP_UA },
          redirect: 'manual',
        });
        expect([301, 302, 308]).toContain(res.status);
        expect(res.headers.get('location')).toMatch(/\/mobile\/$/);
      });
    });
  });

  // ── API routes unaffected ──

  describe('API routes are independent of device detection', () => {
    it('GET /api/health works with mobile UA', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/health', { headers: { 'User-Agent': IPHONE_UA } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
      });
    });

    it('GET /api/projects works with mobile UA', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/projects', {
          headers: { 'User-Agent': IPHONE_UA },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
      });
    });

    it('GET /api/health works with desktop UA (unchanged)', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/health');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
      });
    });
  });

  // ── Static assets ──

  describe('static asset serving', () => {
    it('desktop CSS served from root static', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/css/app.css');
        expect(res.status).toBe(200);
      });
    });

    it('desktop JS served from root static', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/js/common.js');
        expect(res.status).toBe(200);
      });
    });
  });

  // ── <base> tag verification ──

  describe('<base> tag in mobile HTML', () => {
    it('mobile/index.html contains <base href="/mobile/">', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/', { headers: { 'User-Agent': IPHONE_UA } });
        const html = await res.text();
        expect(html).toContain('<base href="/mobile/">');
      });
    });

    it('mobile/preview.html contains <base href="/mobile/">', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(baseUrl + '/preview.html', {
          headers: { 'User-Agent': IPHONE_UA },
        });
        const html = await res.text();
        expect(html).toContain('<base href="/mobile/">');
      });
    });
  });
});
