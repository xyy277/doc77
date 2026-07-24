import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import sharp from 'sharp';
import { validatePath } from '@doc77/core';
import type { ThumbnailSize } from '../types.js';

const SIZE_CONFIG: Record<ThumbnailSize, number> = {
  grid: 320,
  preview: 1200,
};

export function computeSourceHash(
  projectId: number,
  relativePath: string,
  mtime: string,
  size: number,
): string {
  const input = `${projectId}:${relativePath}:${mtime}:${size}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export interface ThumbnailResult {
  cachePath: string;
  relativePath: string;
  width: number;
  height: number;
  exifDate: string | null;
}

/**
 * Generate a thumbnail for the given file.
 * Returns the absolute cache path, dimensions, and EXIF date.
 */
export async function generateThumbnail(
  projectPath: string,
  relativePath: string,
  projectId: number,
  size: ThumbnailSize,
  outputDir: string,
): Promise<ThumbnailResult> {
  const absPath = validatePath(projectPath, relativePath);
  const stats = fs.statSync(absPath);
  const sourceHash = computeSourceHash(
    projectId,
    relativePath,
    stats.mtime.toISOString(),
    stats.size,
  );
  const hashPrefix = sourceHash.slice(0, 2);
  const cacheDir = path.join(outputDir, hashPrefix);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFileName = `${sourceHash}_${size}.webp`;
  const cachePath = path.join(cacheDir, cacheFileName);

  const targetWidth = SIZE_CONFIG[size];

  const image = sharp(absPath);
  const metadata = await image.metadata();

  // Extract EXIF date
  let exifDate: string | null = null;
  if (metadata.exif) {
    try {
      const exifReader = await import('exif-reader');
      const tags = exifReader.default(metadata.exif);
      const dateOriginal = (tags as any)?.exif?.DateTimeOriginal;
      if (dateOriginal) {
        exifDate = new Date(dateOriginal).toISOString();
      }
    } catch {
      // EXIF parse failed, leave as null
    }
  }

  // Generate and save thumbnail
  await image
    .resize(targetWidth, null, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(cachePath);

  return {
    cachePath,
    relativePath: path.posix.join(hashPrefix, cacheFileName),
    width: metadata.width || 0,
    height: metadata.height || 0,
    exifDate,
  };
}
