import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { registerGalleryRoutes } from '../src/routes/register.js';
import { initDatabase, runMigrations, getConnection, closeConnection } from '@doc77/core';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

describe('Gallery API routes', () => {
  const dbPath = path.join(os.tmpdir(), 'doc77-api-test.db');
  const thumbDir = path.join(os.tmpdir(), 'doc77-thumbs');

  beforeAll(async () => {
    await initDatabase(dbPath);
    runMigrations();
    getConnection().prepare(
      "INSERT OR IGNORE INTO projects (id, name, path) VALUES (1, 'test', ?)"
    ).run(thumbDir);
    // Create a test image
    fs.mkdirSync(thumbDir, { recursive: true });
    const sharp = await import('sharp');
    await sharp.default({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).png().toFile(path.join(thumbDir, 'blue.png'));
  });

  afterAll(() => {
    closeConnection();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    fs.rmSync(thumbDir, { recursive: true, force: true });
  });

  it('GET /api/gallery/:projectId returns media entries', async () => {
    const app = express();
    await registerGalleryRoutes(app, { thumbnailsDir: thumbDir });

    // Simple supertest-like call
    const resp = await fetchFromApp(app, '/api/gallery/1?path=');
    expect(resp.entries).toBeDefined();
    expect(Array.isArray(resp.entries)).toBe(true);
  });

  it('GET /api/gallery/:projectId returns 404 for missing project', async () => {
    const app = express();
    await registerGalleryRoutes(app, { thumbnailsDir: thumbDir });

    const resp = await fetchFromApp(app, '/api/gallery/999?path=');
    expect(resp.error).toBeDefined();
  });

  it('POST /api/albums creates an album', async () => {
    const app = express();
    app.use(express.json());
    await registerGalleryRoutes(app, { thumbnailsDir: thumbDir });

    const resp = await fetchFromApp(app, '/api/albums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'API Test Album', description: 'Created via API' }),
    });
    expect(resp.id).toBeGreaterThan(0);
    expect(resp.name).toBe('API Test Album');
  });

  it('GET /api/albums lists albums', async () => {
    const app = express();
    await registerGalleryRoutes(app, { thumbnailsDir: thumbDir });

    const resp = await fetchFromApp(app, '/api/albums');
    expect(Array.isArray(resp)).toBe(true);
  });
});

// Minimal fetch helper for express app testing
async function fetchFromApp(app: express.Application, url: string, init?: RequestInit): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${url}`, init)
        .then((r) => r.json())
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}
