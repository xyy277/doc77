import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, runMigrations, getConnection, closeConnection } from '@doc77/core';
import { createAlbum, listAlbums, updateAlbum, deleteAlbum } from '../src/album/store.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

describe('AlbumStore', () => {
  const dbPath = path.join(os.tmpdir(), 'doc77-album-test.db');

  beforeAll(async () => {
    await initDatabase(dbPath);
    runMigrations();
    // Create a test project for foreign key references
    getConnection().prepare(
      "INSERT OR IGNORE INTO projects (id, name, path) VALUES (1, 'test-project', '/tmp/test')"
    ).run();
  });

  afterAll(() => {
    closeConnection();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('creates and lists albums', () => {
    const album = createAlbum('Test Album', 'A test album');
    expect(album.id).toBeGreaterThan(0);
    expect(album.name).toBe('Test Album');

    const albums = listAlbums();
    expect(albums.length).toBeGreaterThanOrEqual(1);
    expect(albums.some((a) => a.name === 'Test Album')).toBe(true);
  });

  it('updates an album', () => {
    const albums = listAlbums();
    const target = albums.find((a) => a.name === 'Test Album') || albums[0];
    updateAlbum(target.id, { name: 'Updated Album' });
    const updated = listAlbums();
    const found = updated.find((a) => a.id === target.id);
    expect(found?.name).toBe('Updated Album');
  });

  it('deletes an album', () => {
    const albums = listAlbums();
    // Delete the album we updated
    const target = albums.find((a) => a.name === 'Updated Album');
    if (target) {
      deleteAlbum(target.id);
      const remaining = listAlbums();
      expect(remaining.some((a) => a.id === target.id)).toBe(false);
    }
  });
});
