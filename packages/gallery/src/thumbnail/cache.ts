import { getConnection, type DatabaseCompat } from '@doc77/core';

/** Row in thumbnail_cache table */
export interface ThumbnailCacheRow {
  source_hash: string;
  source_path: string;
  source_size: number;
  source_mtime: string;
  grid_path: string | null;
  preview_path: string | null;
  video_cover_path: string | null;
  width: number | null;
  height: number | null;
  exif_date: string | null;
  created_at: string;
}

/** Get cached thumbnail record by hash */
export function getCachedThumbnail(sourceHash: string): ThumbnailCacheRow | undefined {
  const db = getConnection();
  return db.prepare(
    'SELECT * FROM thumbnail_cache WHERE source_hash = ?'
  ).get(sourceHash) as ThumbnailCacheRow | undefined;
}

/** Upsert a thumbnail cache record */
export function upsertThumbnailCache(row: Omit<ThumbnailCacheRow, 'created_at'>): void {
  const db = getConnection();
  db.prepare(`
    INSERT INTO thumbnail_cache
      (source_hash, source_path, source_size, source_mtime, grid_path, preview_path,
       video_cover_path, width, height, exif_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_hash) DO UPDATE SET
      source_mtime = excluded.source_mtime,
      grid_path = excluded.grid_path,
      preview_path = excluded.preview_path,
      video_cover_path = excluded.video_cover_path,
      width = excluded.width,
      height = excluded.height,
      exif_date = excluded.exif_date,
      created_at = datetime('now')
  `).run(
    row.source_hash, row.source_path, row.source_size, row.source_mtime,
    row.grid_path, row.preview_path, row.video_cover_path,
    row.width, row.height, row.exif_date
  );
}

/** Get all thumbnail records for a project by source_path prefix lookup */
export function getCachedByPathPrefix(sourcePath: string): ThumbnailCacheRow | undefined {
  const db = getConnection();
  return db.prepare(
    'SELECT * FROM thumbnail_cache WHERE source_path = ?'
  ).get(sourcePath) as ThumbnailCacheRow | undefined;
}
