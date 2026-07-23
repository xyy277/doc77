import { getConnection, type DatabaseCompat } from '@doc77/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { validatePath } from '@doc77/core';
import { generateThumbnail } from './engine.js';
import type { ThumbnailSize } from '../types.js';

/** Row in thumbnail_cache table */
export interface ThumbnailCacheRow {
  source_hash: string;
  project_id: number;
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
      (source_hash, project_id, source_path, source_size, source_mtime, grid_path, preview_path,
       video_cover_path, width, height, exif_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_hash) DO UPDATE SET
      project_id = excluded.project_id,
      source_mtime = excluded.source_mtime,
      grid_path = excluded.grid_path,
      preview_path = excluded.preview_path,
      video_cover_path = excluded.video_cover_path,
      width = excluded.width,
      height = excluded.height,
      exif_date = excluded.exif_date,
      created_at = datetime('now')
  `).run(
    row.source_hash, row.project_id, row.source_path, row.source_size, row.source_mtime,
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

export interface ResolvedThumbnail {
  cachePath: string;
  width: number;
  height: number;
  exifDate: string | null;
}

/**
 * Get thumbnail from cache or generate it.
 * Checks mtime to detect stale caches.
 */
export async function getOrGenerateThumbnail(
  projectPath: string,
  relativePath: string,
  projectId: number,
  size: ThumbnailSize,
  outputDir: string,
): Promise<ResolvedThumbnail> {
  const absPath = validatePath(projectPath, relativePath);
  const stats = fs.statSync(absPath);
  const sourceHash = computeSourceHashLocal(projectId, relativePath, stats.mtime.toISOString(), stats.size);

  // Check cache
  const cached = getCachedThumbnail(sourceHash);
  if (cached) {
    const sizeField = size === 'grid' ? cached.grid_path : cached.preview_path;
    if (sizeField) {
      const cachedAbsPath = path.join(outputDir, sizeField);
      if (fs.existsSync(cachedAbsPath)) {
        return {
          cachePath: cachedAbsPath,
          width: cached.width || 0,
          height: cached.height || 0,
          exifDate: cached.exif_date,
        };
      }
    }
  }

  // Generate new thumbnail
  const result = await generateThumbnail(projectPath, relativePath, projectId, size, outputDir);

  // Upsert cache record
  upsertThumbnailCache({
    source_hash: sourceHash,
    project_id: projectId,
    source_path: relativePath,
    source_size: stats.size,
    source_mtime: stats.mtime.toISOString(),
    grid_path: size === 'grid' ? result.relativePath : (cached?.grid_path || null),
    preview_path: size === 'preview' ? result.relativePath : (cached?.preview_path || null),
    video_cover_path: cached?.video_cover_path || null,
    width: result.width,
    height: result.height,
    exif_date: result.exifDate || cached?.exif_date || null,
  });

  return {
    cachePath: result.cachePath,
    width: result.width,
    height: result.height,
    exifDate: result.exifDate,
  };
}

function computeSourceHashLocal(projectId: number, relativePath: string, mtime: string, size: number): string {
  const input = `${projectId}:${relativePath}:${mtime}:${size}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
