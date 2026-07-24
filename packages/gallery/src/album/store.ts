import { getConnection } from '@doc77/core';
import type { Album } from '../types.js';

/** List all albums */
export function listAlbums(): (Album & { item_count: number })[] {
  const db = getConnection();
  return db
    .prepare(
      `
    SELECT a.*, COUNT(i.file_path) AS item_count
    FROM gallery_albums a
    LEFT JOIN gallery_album_items i ON i.album_id = a.id
    GROUP BY a.id
    ORDER BY a.sort_order, a.created_at DESC
  `,
    )
    .all() as (Album & { item_count: number })[];
}

/** Create a new album */
export function createAlbum(name: string, description?: string): Album {
  const db = getConnection();
  const result = db
    .prepare('INSERT INTO gallery_albums (name, description) VALUES (?, ?)')
    .run(name, description || '');
  return db
    .prepare('SELECT * FROM gallery_albums WHERE id = ?')
    .get(result.lastInsertRowid) as Album;
}

/** Update an album */
export function updateAlbum(
  id: number,
  fields: { name?: string; description?: string },
): { changes: number } {
  const db = getConnection();
  return db
    .prepare(
      `
    UPDATE gallery_albums
    SET name = COALESCE(?, name),
        description = COALESCE(?, description),
        updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .run(fields.name ?? null, fields.description ?? null, id);
}

/** Delete an album */
export function deleteAlbum(id: number): { changes: number } {
  const db = getConnection();
  db.prepare('DELETE FROM gallery_album_items WHERE album_id = ?').run(id);
  return db.prepare('DELETE FROM gallery_albums WHERE id = ?').run(id);
}

/** Add an item to an album */
export function addAlbumItem(albumId: number, projectId: number, filePath: string): void {
  const db = getConnection();
  const maxOrder = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM gallery_album_items WHERE album_id = ?',
    )
    .get(albumId) as { next_order: number };
  db.prepare(
    'INSERT OR IGNORE INTO gallery_album_items (album_id, project_id, file_path, sort_order) VALUES (?, ?, ?, ?)',
  ).run(albumId, projectId, filePath, maxOrder.next_order);
}

/** Remove an item from an album */
export function removeAlbumItem(albumId: number, projectId: number, filePath: string): void {
  const db = getConnection();
  db.prepare(
    'DELETE FROM gallery_album_items WHERE album_id = ? AND project_id = ? AND file_path = ?',
  ).run(albumId, projectId, filePath);
}

/** List items in an album */
export function listAlbumItems(albumId: number): { project_id: number; file_path: string }[] {
  const db = getConnection();
  return db
    .prepare(
      'SELECT project_id, file_path FROM gallery_album_items WHERE album_id = ? ORDER BY sort_order',
    )
    .all(albumId) as { project_id: number; file_path: string }[];
}
