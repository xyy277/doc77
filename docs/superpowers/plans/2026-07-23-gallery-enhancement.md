# Gallery Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a full-featured image/video gallery as a new `@doc77/gallery` package with server-side thumbnail generation, masonry grid UI, lightbox with EXIF panel, album management, and timeline views.

**Architecture:** New peer package `@doc77/gallery` depends on `@doc77/core` (DB, FS, Express). Backend: sharp for thumbnail generation, exif-reader for metadata. Frontend: vanilla HTML/CSS/JS with Tailwind CDN + Phosphor Icons, dark-only theme, masonry grid layout, reusable gallery-core.js and gallery-lightbox.js modules.

**Tech Stack:** TypeScript, tsup, sharp ^0.33.0, exif-reader ^2.0.0, Phosphor Icons, Tailwind CSS CDN, vanilla JS (zero-build frontend).

**Design Spec:** `docs/planning/gallery-enhancement-design.md`
**UI Reference:** `docs/design/gallery_ui.html` (authoritative — all styles, colors, animations, and interactions must match this file)

## Global Constraints

- Node.js >= 22.x, pnpm >= 9.0.0
- Frontend: zero-build vanilla HTML/CSS/JS (no framework)
- Tailwind CSS CDN for gallery.html (same pattern as preview.html)
- Phosphor Icons via CDN (`unpkg/@phosphor-icons/web`)
- Dark-only theme for gallery.html (color tokens from gallery_ui.html lines 19-42)
- Gallery is a default dependency of @doc77/cli (not optional peer)
- Graceful degradation: if gallery fails to load, existing single-image viewing works unchanged
- All commits must follow format: `type(scope): description` with `Co-Authored-By: xyy277 <907507646@qq.com>` footer
- sharp is already in pnpm-workspace.yaml allowBuilds

---

### Task 1: Package Scaffolding

**Files:**
- Create: `packages/gallery/package.json`
- Create: `packages/gallery/tsconfig.json`
- Create: `packages/gallery/tsup.config.ts`
- Create: `packages/gallery/src/index.ts`
- Create: `packages/gallery/src/types.ts`
- Modify: `pnpm-workspace.yaml` (add `- "packages/gallery"`)
- Modify: `packages/cli/package.json` (add `@doc77/gallery` to dependencies)
- Modify: `packages/cli/tsup.config.ts` (add `'@doc77/gallery'` to external)
- Modify: `packages/core/tsup.config.ts` (add `'@doc77/gallery'` to external)
- Modify: `packages/electron/package.json` (add `@doc77/gallery` to dependencies)

**Interfaces:**
- Produces: `@doc77/gallery` package installable at workspace, `registerGalleryRoutes()` empty stub in `src/index.ts`

- [ ] **Step 1: Create packages/gallery/package.json**

Follow `@doc77/ai` pattern exactly. Copy its structure, adjust name/description/dependencies:
```json
{
  "name": "@doc77/gallery",
  "version": "1.0.4",
  "description": "Doc77 Gallery — thumbnail engine, media gallery UI, album management",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/xyy277/doc77.git"
  },
  "keywords": ["doc77", "gallery", "images", "thumbnails", "media"],
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "files": ["dist"],
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "tsup && node -e \"require('fs').cpSync('src/web','dist/web',{recursive:true})\"",
    "dev": "tsup --watch",
    "clean": "rm -rf dist",
    "test": "vitest run"
  },
  "dependencies": {
    "@doc77/core": "workspace:^",
    "exif-reader": "^2.0.0",
    "sharp": "^0.33.0"
  }
}
```

- [ ] **Step 2: Create packages/gallery/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "references": [
    { "path": "../core" }
  ]
}
```

- [ ] **Step 3: Create packages/gallery/tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@doc77/core', 'sharp', 'exif-reader'],
});
```

- [ ] **Step 4: Create packages/gallery/src/types.ts**

```typescript
/** Thumbnail size presets */
export type ThumbnailSize = 'grid' | 'preview';

/** Media type classification */
export type MediaType = 'image' | 'video';

/** Gallery entry returned by list API */
export interface GalleryEntry {
  name: string;
  path: string;
  type: MediaType;
  extension: string;
  size: number;
  modified: string;
  thumbnail_url: string;
  preview_url: string;
  raw_url: string;
  width: number | null;
  height: number | null;
  exif_date: string | null;
  duration: number | null;
}

/** Gallery list response */
export interface GalleryListResponse {
  entries: GalleryEntry[];
  total: number;
  offset: number;
  limit: number;
}

/** Timeline group */
export interface TimelineGroup {
  label: string;
  count: number;
  start_date: string;
  end_date: string;
  cover: { thumbnail_url: string; preview_url: string };
}

/** Album */
export interface Album {
  id: number;
  name: string;
  description: string;
  cover_source_hash: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Options passed to registerGalleryRoutes */
export interface GalleryOptions {
  thumbnailsDir: string;
}
```

- [ ] **Step 5: Create packages/gallery/src/index.ts (stub)**

```typescript
/**
 * @doc77/gallery — Doc77 媒体库
 *
 * 提供缩略图生成、画廊 API、相册管理和前端 UI。
 */
export { registerGalleryRoutes } from './routes/register.js';
export type { GalleryOptions } from './types.js';
```

- [ ] **Step 6: Register package in workspace**

Add to `pnpm-workspace.yaml` under `packages:`:
```yaml
  - "packages/gallery"
```

- [ ] **Step 7: Add gallery to CLI dependencies**

In `packages/cli/package.json`, add `"@doc77/gallery": "workspace:^"` to `dependencies`. Add `'@doc77/gallery'` to the `external` array in `packages/cli/tsup.config.ts`.

- [ ] **Step 8: Add gallery to core's tsup external**

In `packages/core/tsup.config.ts`, add `'@doc77/gallery'` to the `external` array.

- [ ] **Step 9: Add gallery to Electron dependencies**

In `packages/electron/package.json`, add `"@doc77/gallery": "workspace:^"` to `dependencies`.

- [ ] **Step 10: Install and verify build**

Run:
```bash
pnpm install
pnpm --filter @doc77/gallery build
```
Expected: Build succeeds with empty stub. `dist/index.js` and `dist/index.cjs` generated.

- [ ] **Step 11: Commit**

```bash
git add packages/gallery/ pnpm-workspace.yaml packages/cli/package.json packages/cli/tsup.config.ts packages/core/tsup.config.ts packages/electron/package.json pnpm-lock.yaml
git commit -m "chore(gallery): scaffold @doc77/gallery package with dependencies

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 2: Database Migration — Gallery Tables

**Files:**
- Modify: `packages/core/src/db/migrations.ts` (add `runGalleryMigrations` call and SCHEMA)
- Create: `packages/gallery/src/thumbnail/cache.ts` (stub with DB query functions)
- Create: `packages/gallery/src/album/store.ts` (stub with DB query functions)

**Interfaces:**
- Consumes: `getConnection()` from `@doc77/core`, `DatabaseCompat` type
- Produces: `thumbnail_cache`, `gallery_albums`, `gallery_album_items` tables available in SQLite

- [ ] **Step 1: Add gallery table schemas to core migrations**

In `packages/core/src/db/migrations.ts`, add after the existing `SCHEMA_SQL` constant a new constant and update `runMigrations`:

```typescript
const GALLERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS thumbnail_cache (
  source_hash TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime TEXT NOT NULL,
  grid_path TEXT,
  preview_path TEXT,
  video_cover_path TEXT,
  width INTEGER,
  height INTEGER,
  exif_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_thumbnail_source_path ON thumbnail_cache(source_path);

CREATE TABLE IF NOT EXISTS gallery_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  cover_source_hash TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gallery_album_items (
  album_id INTEGER REFERENCES gallery_albums(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (album_id, project_id, file_path)
);
`;
```

In the `runMigrations` function body, append before the closing brace:
```typescript
// v5: Gallery tables (thumbnail cache, albums)
conn.exec(GALLERY_SCHEMA_SQL);
```

- [ ] **Step 2: Create packages/gallery/src/thumbnail/cache.ts**

```typescript
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
```

- [ ] **Step 3: Create packages/gallery/src/album/store.ts**

```typescript
import { getConnection } from '@doc77/core';
import type { Album } from '../types.js';

/** List all albums */
export function listAlbums(): Album[] {
  const db = getConnection();
  return db.prepare(
    'SELECT * FROM gallery_albums ORDER BY sort_order, created_at DESC'
  ).all() as Album[];
}

/** Create a new album */
export function createAlbum(name: string, description?: string): Album {
  const db = getConnection();
  const result = db.prepare(
    'INSERT INTO gallery_albums (name, description) VALUES (?, ?)'
  ).run(name, description || '');
  return db.prepare('SELECT * FROM gallery_albums WHERE id = ?').get(result.lastInsertRowid) as Album;
}

/** Update an album */
export function updateAlbum(id: number, fields: { name?: string; description?: string }): void {
  const db = getConnection();
  if (fields.name !== undefined) {
    db.prepare('UPDATE gallery_albums SET name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(fields.name, id);
  }
  if (fields.description !== undefined) {
    db.prepare('UPDATE gallery_albums SET description = ?, updated_at = datetime(\'now\') WHERE id = ?').run(fields.description, id);
  }
}

/** Delete an album */
export function deleteAlbum(id: number): void {
  const db = getConnection();
  db.prepare('DELETE FROM gallery_album_items WHERE album_id = ?').run(id);
  db.prepare('DELETE FROM gallery_albums WHERE id = ?').run(id);
}

/** Add an item to an album */
export function addAlbumItem(albumId: number, projectId: number, filePath: string): void {
  const db = getConnection();
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM gallery_album_items WHERE album_id = ?'
  ).get(albumId) as { next_order: number };
  db.prepare(
    'INSERT OR IGNORE INTO gallery_album_items (album_id, project_id, file_path, sort_order) VALUES (?, ?, ?, ?)'
  ).run(albumId, projectId, filePath, maxOrder.next_order);
}

/** Remove an item from an album */
export function removeAlbumItem(albumId: number, projectId: number, filePath: string): void {
  const db = getConnection();
  db.prepare(
    'DELETE FROM gallery_album_items WHERE album_id = ? AND project_id = ? AND file_path = ?'
  ).run(albumId, projectId, filePath);
}
```

- [ ] **Step 4: Verify tables exist**

Run `pnpm build` (to compile gallery migrations), then verify manually that running the app creates the tables. Expected: after `runMigrations()` is called, `thumbnail_cache`, `gallery_albums`, `gallery_album_items` tables exist in the database.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/migrations.ts packages/gallery/src/thumbnail/cache.ts packages/gallery/src/album/store.ts
git commit -m "feat(gallery): add gallery database tables and cache/album store

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 3: Thumbnail Engine — sharp Pipeline

**Files:**
- Create: `packages/gallery/src/thumbnail/engine.ts`

**Interfaces:**
- Consumes: `sharp` npm package, `validatePath` from `@doc77/core`, `ThumbnailSize` from `types.ts`
- Produces: `generateThumbnail(projectPath: string, filePath: string, size: ThumbnailSize, outputDir: string) → Promise<{cachePath: string, width: number, height: number, exifDate: string | null}>`

- [ ] **Step 1: Create packages/gallery/src/thumbnail/engine.ts**

```typescript
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

function computeSourceHash(projectId: number, relativePath: string, mtime: string, size: number): string {
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
  const sourceHash = computeSourceHash(projectId, relativePath, stats.mtime.toISOString(), stats.size);
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/gallery/src/thumbnail/engine.ts
git commit -m "feat(gallery): implement thumbnail generation pipeline with sharp

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 4: Thumbnail Cache Integration

**Files:**
- Modify: `packages/gallery/src/thumbnail/cache.ts` (add `getOrGenerateThumbnail`)

**Interfaces:**
- Consumes: `generateThumbnail` from engine.ts, `getCachedThumbnail`/`upsertThumbnailCache` from cache.ts
- Produces: `getOrGenerateThumbnail(projectPath, relativePath, projectId, size, outputDir) → Promise<{cachePath, width, height, exifDate}>`

- [ ] **Step 1: Add getOrGenerateThumbnail to cache.ts**

Add import and function at the end of `packages/gallery/src/thumbnail/cache.ts`:

```typescript
import { generateThumbnail } from './engine.js';
import type { ThumbnailSize } from '../types.js';

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
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { validatePath } = await import('@doc77/core');

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
  const crypto = require('node:crypto');
  const input = `${projectId}:${relativePath}:${mtime}:${size}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gallery/src/thumbnail/cache.ts
git commit -m "feat(gallery): add cache-or-generate thumbnail logic with mtime validation

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 5: EXIF Reader

**Files:**
- Create: `packages/gallery/src/exif/reader.ts`

**Interfaces:**
- Consumes: `sharp`, `exif-reader`, `validatePath` from `@doc77/core`
- Produces: `readExif(projectPath: string, filePath: string) → Promise<ExifData | null>`

- [ ] **Step 1: Create packages/gallery/src/exif/reader.ts**

```typescript
import sharp from 'sharp';
import { validatePath } from '@doc77/core';

export interface ExifData {
  date: string | null;
  camera: string | null;
  lens: string | null;
  focal_length: string | null;
  aperture: string | null;
  shutter_speed: string | null;
  iso: number | null;
  gps: { latitude: number; longitude: number } | null;
  dimensions: { width: number; height: number };
  file_size: number;
}

/**
 * Read EXIF data from an image file.
 * Uses sharp for metadata extraction and exif-reader for parsing.
 */
export async function readExif(projectPath: string, relativePath: string): Promise<ExifData | null> {
  const absPath = validatePath(projectPath, relativePath);
  const fs = await import('node:fs');
  const stats = fs.statSync(absPath);

  try {
    const image = sharp(absPath);
    const metadata = await image.metadata();

    const data: ExifData = {
      date: null,
      camera: null,
      lens: null,
      focal_length: null,
      aperture: null,
      shutter_speed: null,
      iso: null,
      gps: null,
      dimensions: { width: metadata.width || 0, height: metadata.height || 0 },
      file_size: stats.size,
    };

    if (metadata.exif) {
      try {
        const exifReader = await import('exif-reader');
        const tags = exifReader.default(metadata.exif) as any;
        const exif = tags?.exif || {};
        const image_tags = tags?.image || {};

        if (exif.DateTimeOriginal) {
          data.date = new Date(exif.DateTimeOriginal).toISOString();
        }
        if (image_tags?.Make || image_tags?.Model) {
          data.camera = [image_tags?.Make, image_tags?.Model].filter(Boolean).join(' ');
        }
        if (exif.LensModel) {
          data.lens = exif.LensModel;
        }
        if (exif.FocalLength) data.focal_length = `${exif.FocalLength}mm`;
        if (exif.FNumber) data.aperture = `f/${exif.FNumber}`;
        if (exif.ExposureTime) {
          const denom = Math.round(1 / exif.ExposureTime);
          data.shutter_speed = `1/${denom}s`;
        }
        if (exif.ISO) data.iso = exif.ISO;

        // GPS
        const gps = tags?.gps || {};
        if (gps.GPSLatitude && gps.GPSLongitude) {
          data.gps = {
            latitude: gps.GPSLatitude,
            longitude: gps.GPSLongitude,
          };
        }
      } catch {
        // EXIF parse failed, return partial data
      }
    }

    return data;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gallery/src/exif/reader.ts
git commit -m "feat(gallery): implement EXIF metadata reader with sharp + exif-reader

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 6: API Routes — Thumbnails, Gallery List, EXIF

**Files:**
- Create: `packages/gallery/src/routes/thumbnail.ts`
- Create: `packages/gallery/src/routes/gallery.ts`
- Create: `packages/gallery/src/routes/exif.ts`

**Interfaces:**
- Consumes: Express `Request`/`Response`, `getOrGenerateThumbnail` from cache.ts, `readExif` from exif/reader.ts, `validatePath`/`listDir` from `@doc77/core`
- Produces: Express route handlers returning JSON or binary

- [ ] **Step 1: Create packages/gallery/src/routes/thumbnail.ts**

```typescript
import * as path from 'node:path';
import type { Request, Response } from 'express';
import { getConnection } from '@doc77/core';
import type { GalleryOptions } from '../types.js';
import { getOrGenerateThumbnail } from '../thumbnail/cache.js';

/** GET /api/thumbnails/:projectId?path=&size=grid|preview */
export function createThumbnailHandler(opts: GalleryOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    const projectId = parseInt(req.params.projectId, 10);
    const filePath = req.query.path as string;
    const size = (req.query.size as string) === 'preview' ? 'preview' : 'grid';

    if (isNaN(projectId) || !filePath) {
      res.status(400).json({ error: 'Invalid project id or missing path' });
      return;
    }

    try {
      const db = getConnection();
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const result = await getOrGenerateThumbnail(
        project.path, filePath, projectId, size, opts.thumbnailsDir
      );

      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.setHeader('Content-Type', 'image/webp');
      res.sendFile(result.cachePath);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}
```

- [ ] **Step 2: Create packages/gallery/src/routes/gallery.ts**

```typescript
import type { Request, Response } from 'express';
import { getConnection, listDir, validatePath } from '@doc77/core';
import type { GalleryEntry, GalleryListResponse, TimelineGroup } from '../types.js';
import { getCachedThumbnail } from '../thumbnail/cache.js';

const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.bmp','.ico','.avif']);
const VIDEO_EXTS = new Set(['.mp4','.webm','.mov','.mkv','.avi','.m4v']);

function isMediaFile(name: string): 'image' | 'video' | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

function filenameToExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** GET /api/gallery/:projectId?path=&sort=name|date|size&order=asc|desc&offset=0&limit=100&types=image,video */
export function createGalleryListHandler() {
  return (req: Request, res: Response): void => {
    const projectId = parseInt(req.params.projectId, 10);
    const dirPath = (req.query.path as string) || '';
    const sort = (req.query.sort as string) || 'name';
    const order = (req.query.order as string) || 'asc';
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 200);
    const types = (req.query.types as string) || 'image,video';
    const allowedTypes = new Set(types.split(','));

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }

    try {
      const db = getConnection();
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const absPath = dirPath ? validatePath(project.path, dirPath) : project.path;
      const entries = listDir(absPath);
      const mediaEntries: GalleryEntry[] = [];

      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        const mediaType = isMediaFile(entry.name);
        if (!mediaType || !allowedTypes.has(mediaType)) continue;

        const relativePath = dirPath ? `${dirPath}/${entry.name}` : entry.name;

        mediaEntries.push({
          name: entry.name,
          path: relativePath,
          type: mediaType,
          extension: filenameToExtension(entry.name),
          size: entry.size,
          modified: entry.modified,
          thumbnail_url: `/api/thumbnails/${projectId}?path=${encodeURIComponent(relativePath)}&size=grid`,
          preview_url: `/api/thumbnails/${projectId}?path=${encodeURIComponent(relativePath)}&size=preview`,
          raw_url: `/api/raw/${projectId}?path=${encodeURIComponent(relativePath)}`,
          width: null,
          height: null,
          exif_date: null,
          duration: null,
        });
      }

      // Sort
      mediaEntries.sort((a, b) => {
        const mul = order === 'desc' ? -1 : 1;
        if (sort === 'date') return mul * (a.modified.localeCompare(b.modified));
        if (sort === 'size') return mul * (a.size - b.size);
        return mul * a.name.localeCompare(b.name);
      });

      const total = mediaEntries.length;
      const paged = mediaEntries.slice(offset, offset + limit);

      const response: GalleryListResponse = {
        entries: paged,
        total,
        offset,
        limit,
      };
      res.json(response);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}

/** GET /api/gallery/timeline/:projectId?path= */
export function createTimelineHandler() {
  return (req: Request, res: Response): void => {
    const projectId = parseInt(req.params.projectId, 10);
    const dirPath = (req.query.path as string) || '';

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }

    try {
      const db = getConnection();
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Get all cached thumbnails for this project (by path prefix scan)
      const rows = db.prepare(
        `SELECT source_path, exif_date, source_mtime, grid_path, preview_path
         FROM thumbnail_cache
         WHERE source_path LIKE ?`
      ).all(dirPath ? `${dirPath}%` : '%') as any[];

      // Group by month
      const groups: Map<string, { count: number; first: any }> = new Map();
      for (const row of rows) {
        const date = row.exif_date || row.source_mtime;
        const month = date.slice(0, 7); // YYYY-MM
        if (!groups.has(month)) {
          groups.set(month, { count: 0, first: row });
        }
        groups.get(month)!.count++;
      }

      const timeline: TimelineGroup[] = Array.from(groups.entries())
        .sort((a, b) => b[0].localeCompare(a[0])) // newest first
        .map(([label, data]) => ({
          label,
          count: data.count,
          start_date: `${label}-01`,
          end_date: `${label}-31`,
          cover: {
            thumbnail_url: `/api/thumbnails/${projectId}?path=${encodeURIComponent(data.first.source_path)}&size=grid`,
            preview_url: `/api/thumbnails/${projectId}?path=${encodeURIComponent(data.first.source_path)}&size=preview`,
          },
        }));

      res.json({ groups: timeline });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}
```

- [ ] **Step 3: Create packages/gallery/src/routes/exif.ts**

```typescript
import type { Request, Response } from 'express';
import { getConnection } from '@doc77/core';
import { readExif } from '../exif/reader.js';

/** GET /api/exif/:projectId?path= */
export function createExifHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const projectId = parseInt(req.params.projectId, 10);
    const filePath = req.query.path as string;

    if (isNaN(projectId) || !filePath) {
      res.status(400).json({ error: 'Invalid project id or missing path' });
      return;
    }

    try {
      const db = getConnection();
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const data = await readExif(project.path, filePath);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/gallery/src/routes/
git commit -m "feat(gallery): implement thumbnail, gallery list, timeline, and EXIF API routes

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 7: Album API Routes

**Files:**
- Create: `packages/gallery/src/album/routes.ts`

**Interfaces:**
- Consumes: Album store functions from `album/store.ts`
- Produces: Express route handler functions for album CRUD

- [ ] **Step 1: Create packages/gallery/src/album/routes.ts**

```typescript
import type { Request, Response } from 'express';
import { listAlbums, createAlbum, updateAlbum, deleteAlbum, addAlbumItem, removeAlbumItem } from './store.js';

export function createAlbumListHandler() {
  return (_req: Request, res: Response): void => {
    try {
      const albums = listAlbums();
      res.json(albums);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}

export function createAlbumCreateHandler() {
  return (req: Request, res: Response): void => {
    const { name, description } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    try {
      const album = createAlbum(name, description);
      res.status(201).json(album);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}

export function createAlbumUpdateHandler() {
  return (req: Request, res: Response): void => {
    const albumId = parseInt(req.params.albumId, 10);
    if (isNaN(albumId)) {
      res.status(400).json({ error: 'Invalid album id' });
      return;
    }
    try {
      updateAlbum(albumId, req.body);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}

export function createAlbumDeleteHandler() {
  return (req: Request, res: Response): void => {
    const albumId = parseInt(req.params.albumId, 10);
    if (isNaN(albumId)) {
      res.status(400).json({ error: 'Invalid album id' });
      return;
    }
    try {
      deleteAlbum(albumId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}

export function createAlbumAddItemHandler() {
  return (req: Request, res: Response): void => {
    const albumId = parseInt(req.params.albumId, 10);
    const { project_id, file_path } = req.body;
    if (isNaN(albumId) || !project_id || !file_path) {
      res.status(400).json({ error: 'albumId, project_id, and file_path are required' });
      return;
    }
    try {
      addAlbumItem(albumId, project_id, file_path);
      res.status(201).json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}

export function createAlbumRemoveItemHandler() {
  return (req: Request, res: Response): void => {
    const albumId = parseInt(req.params.albumId, 10);
    const { project_id, file_path } = req.body;
    if (isNaN(albumId) || !project_id || !file_path) {
      res.status(400).json({ error: 'albumId, project_id, and file_path are required' });
      return;
    }
    try {
      removeAlbumItem(albumId, project_id, file_path);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gallery/src/album/routes.ts
git commit -m "feat(gallery): implement album CRUD API routes

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 8: Route Registration

**Files:**
- Create: `packages/gallery/src/routes/register.ts`
- Modify: `packages/gallery/src/index.ts`

**Interfaces:**
- Consumes: All route handlers from routes/thumbnail.ts, routes/gallery.ts, routes/exif.ts, album/routes.ts
- Produces: `registerGalleryRoutes(app: express.Application, opts: GalleryOptions): void`

- [ ] **Step 1: Create packages/gallery/src/routes/register.ts**

```typescript
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Application } from 'express';
import type { GalleryOptions } from '../types.js';
import { createThumbnailHandler } from './thumbnail.js';
import { createGalleryListHandler, createTimelineHandler } from './gallery.js';
import { createExifHandler } from './exif.js';
import {
  createAlbumListHandler, createAlbumCreateHandler,
  createAlbumUpdateHandler, createAlbumDeleteHandler,
  createAlbumAddItemHandler, createAlbumRemoveItemHandler,
} from '../album/routes.js';

/**
 * Register all gallery API routes and static web assets on the Express app.
 */
export function registerGalleryRoutes(app: Application, opts: GalleryOptions): void {
  // --- API Routes ---
  const thumbHandler = createThumbnailHandler(opts);
  const galleryList = createGalleryListHandler();
  const timeline = createTimelineHandler();
  const exif = createExifHandler();

  app.get('/api/gallery/:projectId', galleryList);
  app.get('/api/gallery/timeline/:projectId', timeline);
  app.get('/api/thumbnails/:projectId', thumbHandler);
  app.get('/api/exif/:projectId', exif);

  app.get('/api/albums', createAlbumListHandler());
  app.post('/api/albums', createAlbumCreateHandler());
  app.put('/api/albums/:albumId', createAlbumUpdateHandler());
  app.delete('/api/albums/:albumId', createAlbumDeleteHandler());
  app.post('/api/albums/:albumId/items', createAlbumAddItemHandler());
  app.delete('/api/albums/:albumId/items', createAlbumRemoveItemHandler());

  // --- Static Web Assets ---
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const webCandidates = [
    path.join(moduleDir, '..', 'web'),           // dist/web/
    path.join(moduleDir, '..', 'src', 'web'),    // dev fallback
  ];
  let webDir = '';
  for (const candidate of webCandidates) {
    if (fs.existsSync(path.join(candidate, 'gallery.html'))) {
      webDir = candidate;
      break;
    }
  }

  if (webDir) {
    app.use('/gallery', (req, _res, next) => {
      // Serve gallery.html at /gallery and /gallery.html
      if (req.path === '/' || req.path === '/index.html' || req.path === '') {
        req.url = '/gallery.html';
      }
      next();
    }, ((await import('express')).static as any)(webDir));
  }
}
```

Note: The static file serving uses dynamic import for express since the `express.static` signature changed in v5. Adjust based on actual express version in use.

- [ ] **Step 2: Update packages/gallery/src/index.ts exports**

Replace the stub with:
```typescript
/**
 * @doc77/gallery — Doc77 媒体库
 *
 * 提供缩略图生成、画廊 API、相册管理和前端 UI。
 */
export { registerGalleryRoutes } from './routes/register.js';
export { getOrGenerateThumbnail } from './thumbnail/cache.js';
export { readExif } from './exif/reader.js';
export { listAlbums, createAlbum, updateAlbum, deleteAlbum, addAlbumItem, removeAlbumItem } from './album/store.js';
export type { GalleryOptions, GalleryEntry, GalleryListResponse, TimelineGroup, Album } from './types.js';
export type { ExifData } from './exif/reader.js';
```

- [ ] **Step 3: Verify build**

```bash
pnpm --filter @doc77/gallery build
```
Expected: Build succeeds, `dist/` contains compiled JS and `dist/web/` directory (empty for now).

- [ ] **Step 4: Commit**

```bash
git add packages/gallery/src/routes/register.ts packages/gallery/src/index.ts
git commit -m "feat(gallery): implement route registration and update public exports

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 9: CLI Integration — Register Gallery in doc77.ts

**Files:**
- Modify: `packages/cli/src/bin/doc77.ts` (add gallery detection, route registration, capability)

**Interfaces:**
- Consumes: `registerGalleryRoutes` from `@doc77/gallery`
- Produces: Gallery API routes registered on Express app, `gallery` capability exposed

- [ ] **Step 1: Add gallery detection to detectModules()**

In `packages/cli/src/bin/doc77.ts`, find the `detectModules` function and add:
```typescript
let galleryAvailable = false;

async function detectModules() {
  // ... existing mcp/ai detection ...
  try {
    const enabled = getConfig('gallery.enabled');
    if (enabled !== 'false') {
      await import('@doc77/gallery');
      galleryAvailable = true;
    }
  } catch { /* Gallery not installed, sharp missing, or platform incompatible */ }
}
```

- [ ] **Step 2: Register gallery routes (after AI route registration)**

Add after the AI chat route registration block:
```typescript
// Register gallery routes (default install, gracefully degrade)
if (galleryAvailable) {
  try {
    const { registerGalleryRoutes } = await import('@doc77/gallery');
    registerGalleryRoutes(app, {
      thumbnailsDir: path.join(os.homedir(), '.doc77', 'thumbnails'),
    });
  } catch { /* Gallery init failed */ }
}
```

- [ ] **Step 3: Update capabilities injection**

Find the `setCapabilities` call and add `gallery`:
```typescript
setCapabilities({
  ai: aiAvailable,
  mcp: mcpAvailable,
  translate: translateAvailable,
  gallery: galleryAvailable,
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/bin/doc77.ts
git commit -m "feat(cli): integrate @doc77/gallery as default dependency with graceful degradation

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 10: Core — Expose gallery capability and update capabilities type

**Files:**
- Modify: `packages/core/src/server/app.ts` (update `setCapabilities` type to include `gallery`)

**Interfaces:**
- Consumes: None
- Produces: `gallery: boolean` in `/api/capabilities` response

- [ ] **Step 1: Update capabilities type in app.ts**

Find the `_capabilities` variable and `setCapabilities` function in `packages/core/src/server/app.ts` (near line 70-72). Update:

```typescript
let _capabilities = { ai: false, mcp: false, translate: false, gallery: false };
export function setCapabilities(caps: { ai: boolean; mcp: boolean; translate: boolean; gallery: boolean }) {
  _capabilities = { ..._capabilities, ...caps };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/server/app.ts
git commit -m "feat(core): add gallery flag to capabilities system

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 11: Frontend — gallery.html (Page Shell)

**Files:**
- Create: `packages/gallery/src/web/gallery.html`

**Interfaces:**
- Consumes: None (standalone HTML page)
- Produces: Full gallery SPA at `/gallery` or `/gallery.html?project=<id>`

**Reference:** `docs/design/gallery_ui.html` — replicate the exact DOM structure (lines 122-357), CSS (lines 1-119), and Tailwind config (lines 11-43).

- [ ] **Step 1: Create gallery.html from the UI reference**

Create `packages/gallery/src/web/gallery.html` with the full HTML structure matching `docs/design/gallery_ui.html` exactly. Key sections:

1. `<head>`: Tailwind CDN, Phosphor Icons CDN, Google Fonts Inter, Tailwind config with doc77 color palette, custom CSS for masonry grid/scrollbar/cards/lightbox/selection mode (lines 1-119 of UI file)
2. `<header>`: App bar with back button, breadcrumbs, search, view toggles, sort/filter, upload, select button (lines 124-187 of UI file)
3. `<aside id="sidebar">`: Navigation (Photos/Timeline/Videos/Favorites), Folders tree, Albums list, Storage bar (lines 192-291 of UI file)
4. `<main>`: Selection toolbar overlay (lines 297-312), scrollable masonry grid area with group headers (lines 314-355)
5. `<div id="lightbox">`: Full lightbox with toolbar, image area, info panel (lines 360-486)

Add a query-pased project selector at the top of the page JS:
```javascript
// Read project from URL parameter
const urlParams = new URLSearchParams(window.location.search);
const currentProjectId = urlParams.get('project');
```

- [ ] **Step 2: Replace mock data with API wiring placeholders**

Replace the mock data generation (lines 488-523) with:
```javascript
async function fetchGallery(projectId, path = '', offset = 0) {
  const resp = await fetch(`/api/gallery/${projectId}?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`);
  return resp.json();
}

async function fetchTimeline(projectId, path = '') {
  const resp = await fetch(`/api/gallery/timeline/${projectId}?path=${encodeURIComponent(path)}`);
  return resp.json();
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/gallery/src/web/gallery.html
git commit -m "feat(gallery): create gallery.html page shell with full UI from design reference

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 12: Frontend — gallery-core.js (Grid, Lazy Load, Selection)

**Files:**
- Create: `packages/gallery/src/web/js/gallery-core.js`

**Interfaces:**
- Consumes: Gallery API (`/api/gallery/:projectId`), thumbnail URLs
- Produces: `createMediaCard(item) → HTMLElement`, `renderGrid(container, items)`, `setupLazyLoading()`, selection mode toggle

**Reference:** `docs/design/gallery_ui.html` lines 488-694 (JS rendering and selection logic)

- [ ] **Step 1: Extract createMediaCard from UI reference**

Create `packages/gallery/src/web/js/gallery-core.js` with:

```javascript
// gallery-core.js — Shared masonry grid and card rendering
// Reused by both gallery.html and preview.html

const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.bmp','.ico','.avif']);
const VIDEO_EXTS = new Set(['.mp4','.webm','.mov','.mkv','.avi','.m4v']);

function isMediaFile(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

/**
 * Create a masonry grid card element.
 * @param {Object} item - Gallery entry from API
 * @returns {HTMLElement}
 */
function createMediaCard(item) {
  const wrapper = document.createElement('div');
  wrapper.className = 'masonry-item gallery-item relative rounded-lg overflow-hidden group cursor-pointer bg-doc77-800 image-card-hover border border-doc77-700/50';
  wrapper.dataset.id = item.path;

  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'img-wrapper relative w-full';

  const img = document.createElement('img');
  img.src = item.thumbnail_url;
  img.className = 'absolute top-0 left-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105';
  img.loading = 'lazy';
  img.alt = item.name;

  // Preserve aspect ratio to prevent layout shift
  if (item.width && item.height) {
    imgWrapper.style.paddingBottom = `${(item.height / item.width) * 100}%`;
    img.onload = function() { imgWrapper.style.paddingBottom = ''; };
  } else {
    imgWrapper.style.paddingBottom = '75%';
  }

  // Bottom gradient overlay
  const overlay = document.createElement('div');
  overlay.className = 'absolute inset-0 img-overlay opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3';
  const nameText = document.createElement('span');
  nameText.className = 'text-white text-xs font-medium truncate drop-shadow-md';
  nameText.textContent = item.name;
  overlay.appendChild(nameText);

  // Video badge
  if (item.type === 'video') {
    const vidBadge = document.createElement('div');
    vidBadge.className = 'absolute top-2 right-2 bg-black/60 backdrop-blur-md rounded-md px-1.5 py-0.5 flex items-center gap-1 text-[10px] text-white font-medium shadow-sm border border-white/10';
    vidBadge.innerHTML = '<i class="ph-fill ph-play-circle"></i> ' + (item.duration || '');
    imgWrapper.appendChild(vidBadge);
  }

  // Selection checkbox
  const checkbox = document.createElement('div');
  checkbox.className = 'gallery-item-checkbox absolute top-2 left-2 w-5 h-5 rounded-full border-2 border-white/70 bg-black/20 backdrop-blur-sm items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-all z-10';
  checkbox.innerHTML = '<i class="ph-bold ph-check text-xs opacity-0 scale-50 transition-all"></i>';

  imgWrapper.appendChild(img);
  imgWrapper.appendChild(overlay);
  imgWrapper.appendChild(checkbox);
  wrapper.appendChild(imgWrapper);

  return wrapper;
}

/**
 * Render media items into a masonry grid container.
 * Groups items by month if grouping is enabled.
 * @param {HTMLElement} container
 * @param {Array} items
 * @param {Object} options - { grouped: boolean, onCardClick: function, projectId: number }
 */
function renderGrid(container, items, options = {}) {
  container.innerHTML = '';

  if (options.grouped && items.length > 0) {
    // Group by month (from exif_date or modified)
    const groups = new Map();
    for (const item of items) {
      const month = (item.exif_date || item.modified).slice(0, 7);
      if (!groups.has(month)) groups.set(month, []);
      groups.get(month).push(item);
    }

    for (const [label, groupItems] of groups) {
      const section = document.createElement('div');
      section.className = 'mb-8';

      const header = document.createElement('div');
      header.className = 'sticky top-0 bg-[#0b1121]/95 backdrop-blur-sm z-10 py-2 mb-4 flex items-center justify-between border-b border-doc77-800/50';
      header.innerHTML = '<div class="flex items-center gap-2"><h2 class="text-lg font-bold text-doc77-100">' + label + '</h2><span class="text-doc77-500 text-sm font-medium bg-doc77-800/50 px-2 py-0.5 rounded-full">' + groupItems.length + ' items</span></div>';
      section.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'masonry-grid';
      for (const item of groupItems) {
        const card = createMediaCard(item);
        card.addEventListener('click', (e) => {
          if (options.onCardClick) options.onCardClick(item, e);
        });
        grid.appendChild(card);
      }
      section.appendChild(grid);
      container.appendChild(section);
    }
  } else {
    const grid = document.createElement('div');
    grid.className = 'masonry-grid';
    for (const item of items) {
      const card = createMediaCard(item);
      card.addEventListener('click', (e) => {
        if (options.onCardClick) options.onCardClick(item, e);
      });
      grid.appendChild(card);
    }
    container.appendChild(grid);
  }
}

/**
 * Setup Intersection Observer for lazy loading images.
 */
function setupLazyLoading() {
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
          }
          observer.unobserve(img);
        }
      }
    }, { rootMargin: '200px' });

    document.querySelectorAll('img[loading="lazy"]').forEach(img => observer.observe(img));
  }
}

// Export for use in other scripts
window.GalleryCore = { createMediaCard, renderGrid, setupLazyLoading, isMediaFile };
```

- [ ] **Step 2: Commit**

```bash
git add packages/gallery/src/web/js/gallery-core.js
git commit -m "feat(gallery): create gallery-core.js with masonry grid, cards, and lazy loading

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 13: Frontend — gallery-lightbox.js (Enhanced Lightbox + EXIF Panel)

**Files:**
- Create: `packages/gallery/src/web/js/gallery-lightbox.js`

**Interfaces:**
- Consumes: `/api/exif/:projectId` for metadata, `/api/raw/:projectId` for full image
- Produces: `GalleryLightbox.open(item, items, projectId)`, `GalleryLightbox.close()`

**Reference:** `docs/design/gallery_ui.html` lines 360-486 (HTML), 697-775 (JS logic)

- [ ] **Step 1: Create gallery-lightbox.js**

```javascript
// gallery-lightbox.js — Enhanced lightbox with EXIF info panel
// Replaces the simple lightbox in preview.js

window.GalleryLightbox = (function() {
  let state = {
    items: [],
    currentIndex: -1,
    projectId: null,
    visible: false,
  };

  function open(item, allItems, projectId) {
    state.items = allItems;
    state.currentIndex = allItems.findIndex(i => i.path === item.path);
    state.projectId = projectId;
    state.visible = true;
    render();
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    state.visible = false;
    const lb = document.getElementById('galleryLightbox');
    if (lb) lb.remove();
    document.removeEventListener('keydown', onKeydown);
  }

  function nav(direction) {
    let newIdx = state.currentIndex + direction;
    if (newIdx < 0) newIdx = state.items.length - 1;
    if (newIdx >= state.items.length) newIdx = 0;
    state.currentIndex = newIdx;
    updateImage();
    fetchExif();
  }

  function updateImage() {
    const item = state.items[state.currentIndex];
    const imgEl = document.getElementById('lb-image');
    if (item.type === 'video') {
      imgEl.style.display = 'none';
      let vid = document.getElementById('lb-video');
      if (!vid) {
        vid = document.createElement('video');
        vid.id = 'lb-video';
        vid.controls = true;
        vid.className = 'max-w-full max-h-full object-contain';
        document.getElementById('lightbox-content-area').appendChild(vid);
      }
      vid.src = item.raw_url;
      vid.style.display = '';
    } else {
      const vid = document.getElementById('lb-video');
      if (vid) vid.style.display = 'none';
      imgEl.style.display = '';
      imgEl.src = item.preview_url || item.raw_url;
    }
    document.getElementById('lb-filename').textContent = item.name;
    document.getElementById('lb-date').textContent = item.exif_date ? new Date(item.exif_date).toLocaleString() : item.modified;
  }

  async function fetchExif() {
    const item = state.items[state.currentIndex];
    if (item.type !== 'image') return;
    try {
      const resp = await fetch(`/api/exif/${state.projectId}?path=${encodeURIComponent(item.path)}`);
      const data = await resp.json();
      if (data) updateInfoPanel(data);
    } catch {}
  }

  function updateInfoPanel(data) {
    // Update the info panel DOM — File Info, Camera EXIF, Location sections
    // Follow gallery_ui.html lines 416-484 exactly
  }

  function toggleInfoPanel() {
    const panel = document.getElementById('lb-info-panel');
    if (panel) panel.classList.toggle('translate-x-full');
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') nav(1);
    else if (e.key === 'ArrowLeft') nav(-1);
    else if (e.key === 'i' || e.key === 'I') toggleInfoPanel();
  }

  function render() {
    // Build full lightbox DOM matching gallery_ui.html lines 360-486
    const overlay = document.createElement('div');
    overlay.id = 'galleryLightbox';
    overlay.className = 'fixed inset-0 z-50 bg-black/95 flex flex-col';
    overlay.style.transition = 'opacity 0.3s';

    overlay.innerHTML = `
<div class="flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 right-0 z-10">
  <div class="flex items-center gap-3">
    <button class="text-white hover:text-doc77-300 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" onclick="GalleryLightbox.close()">
      <i class="ph ph-arrow-left text-xl"></i>
    </button>
    <div>
      <div class="text-white font-medium drop-shadow-md" id="lb-filename"></div>
      <div class="text-doc77-300 text-xs drop-shadow-md" id="lb-date"></div>
    </div>
  </div>
  <div class="flex items-center gap-2">
    <button class="text-white hover:text-doc77-300 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Download">
      <i class="ph ph-download-simple text-xl"></i>
    </button>
    <button class="text-white hover:text-doc77-300 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Info" onclick="GalleryLightbox.toggleInfoPanel()">
      <i class="ph ph-info text-xl"></i>
    </button>
  </div>
</div>
<div class="flex-1 flex items-center justify-center relative overflow-hidden" id="lightbox-content-area">
  <button class="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white p-3 bg-black/20 hover:bg-black/50 rounded-full backdrop-blur-sm transition-all z-10 hidden sm:flex" onclick="GalleryLightbox.nav(-1)">
    <i class="ph ph-caret-left text-3xl"></i>
  </button>
  <img src="" alt="" id="lb-image" class="max-w-full max-h-full object-contain select-none">
  <button class="absolute right-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white p-3 bg-black/20 hover:bg-black/50 rounded-full backdrop-blur-sm transition-all z-10 hidden sm:flex" onclick="GalleryLightbox.nav(1)">
    <i class="ph ph-caret-right text-3xl"></i>
  </button>
</div>
<div id="lb-info-panel" class="absolute top-0 right-0 bottom-0 w-80 bg-doc77-900 border-l border-doc77-800 transform translate-x-full transition-transform duration-300 overflow-y-auto no-scrollbar shadow-2xl flex flex-col z-20">
  <div class="p-4 border-b border-doc77-800 flex items-center justify-between sticky top-0 bg-doc77-900 z-10">
    <h3 class="font-semibold text-doc77-100 flex items-center gap-2"><i class="ph ph-info"></i> Details</h3>
    <button class="text-doc77-400 hover:text-white" onclick="GalleryLightbox.toggleInfoPanel()"><i class="ph ph-x"></i></button>
  </div>
  <div class="p-4 space-y-6" id="lb-info-content">
    <!-- Populated by updateInfoPanel() -->
  </div>
</div>`;

    document.body.appendChild(overlay);
    updateImage();
    fetchExif();
  }

  return { open, close, nav, toggleInfoPanel };
})();
```

- [ ] **Step 2: Commit**

```bash
git add packages/gallery/src/web/js/gallery-lightbox.js
git commit -m "feat(gallery): create gallery-lightbox.js with EXIF info panel and keyboard navigation

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 14: Frontend — gallery-album.js + Dashboard Integration

**Files:**
- Create: `packages/gallery/src/web/js/gallery-album.js`
- Modify: `packages/core/src/web/js/dashboard.js` (add Gallery button to project cards)
- Modify: `packages/core/src/web/index.html` (add Gallery nav link if capability present)

**Interfaces:**
- Consumes: `/api/capabilities`, `/api/albums`
- Produces: Album management UI, Gallery entry points from dashboard

- [ ] **Step 1: Create gallery-album.js**

```javascript
// gallery-album.js — Album management for gallery page

window.GalleryAlbum = (function() {
  async function fetchAlbums() {
    const resp = await fetch('/api/albums');
    return resp.json();
  }

  async function createAlbum(name, description) {
    const resp = await fetch('/api/albums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    return resp.json();
  }

  async function addToAlbum(albumId, projectId, filePaths) {
    for (const filePath of filePaths) {
      await fetch(`/api/albums/${albumId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, file_path: filePath }),
      });
    }
  }

  async function deleteAlbum(albumId) {
    await fetch(`/api/albums/${albumId}`, { method: 'DELETE' });
  }

  async function renderAlbumSidebar(container, projectId) {
    const albums = await fetchAlbums();
    container.innerHTML = albums.map(a =>
      `<li><a href="#" class="flex items-center gap-3 px-3 py-1.5 rounded-lg text-doc77-300 hover:bg-doc77-800 transition-colors">
        <div class="w-6 h-6 rounded bg-gradient-to-br from-blue-400 to-indigo-600 flex items-center justify-center shrink-0 shadow-sm">
          <i class="ph-fill ph-images text-white text-xs"></i>
        </div>
        <span class="truncate flex-1">${escHtml(a.name)}</span>
        <span class="text-xs text-doc77-500">${a.item_count || 0}</span>
      </a></li>`
    ).join('');
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  return { fetchAlbums, createAlbum, addToAlbum, deleteAlbum, renderAlbumSidebar };
})();
```

- [ ] **Step 2: Add Gallery button to dashboard project cards**

In `packages/core/src/web/js/dashboard.js`, find the project card rendering function. After checking capabilities via `fetch('/api/capabilities')`:

```javascript
// When gallery capability is available, add a Gallery button to each project card
if (capabilities.gallery) {
  const galleryBtn = document.createElement('a');
  galleryBtn.href = `/gallery?project=${project.id}`;
  galleryBtn.className = 'gallery-btn';
  galleryBtn.innerHTML = '<i class="ph ph-image"></i> Gallery';
  card.appendChild(galleryBtn);
}
```

For the dashboard nav bar in `index.html`, add a Gallery link that only shows when `gallery: true` capability is detected.

- [ ] **Step 3: Commit**

```bash
git add packages/gallery/src/web/js/gallery-album.js packages/core/src/web/js/dashboard.js packages/core/src/web/index.html
git commit -m "feat(gallery): add album management UI and dashboard gallery entry points

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 15: Preview Page Integration — Gallery Toggle

**Files:**
- Modify: `packages/core/src/web/js/preview.js` (add list/grid toggle, wire gallery-core)
- Modify: `packages/core/src/web/preview.html` (add toggle button HTML, gallery JS scripts)

**Interfaces:**
- Consumes: `GalleryCore` from gallery-core.js, `GalleryLightbox` from gallery-lightbox.js
- Produces: List/Grid toggle in file tree sidebar

- [ ] **Step 1: Add toggle button to preview.html**

Add near the file tree section of the sidebar:
```html
<div class="view-toggle" id="viewToggle" style="display:none">
  <button class="active" data-view="list">📋 List</button>
  <button data-view="grid">📷 Grid</button>
</div>
```

Show it when gallery capability is available.

- [ ] **Step 2: Add toggle logic to preview.js**

```javascript
// In preview.js, after document ready:
let currentViewMode = 'list';

function setupGalleryToggle() {
  const toggle = document.getElementById('viewToggle');
  if (!toggle) return;
  toggle.style.display = 'flex';

  toggle.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      currentViewMode = btn.dataset.view;
      toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (currentViewMode === 'grid') {
        loadGalleryView();
      } else {
        loadListView();
      }
    });
  });
}

async function loadGalleryView() {
  const treeContainer = document.getElementById('tree');
  if (!treeContainer) return;
  treeContainer.innerHTML = '<div class="masonry-grid" id="previewGalleryGrid"></div>';

  const resp = await fetch(`/api/gallery/${pid}?path=${encodeURIComponent(currentDir || '')}&limit=100`);
  const data = await resp.json();
  const grid = document.getElementById('previewGalleryGrid');

  window.GalleryCore.renderGrid(grid, data.entries, {
    grouped: true,
    projectId: pid,
    onCardClick: (item) => {
      window.GalleryLightbox.open(item, data.entries, pid);
    },
  });
  window.GalleryCore.setupLazyLoading();
}

function loadListView() {
  // Restore file tree — call existing loadTree()
  loadTree(currentDir || '');
}
```

- [ ] **Step 3: Add gallery script tags to preview.html**

```html
<script src="/gallery/js/gallery-core.js"></script>
<script src="/gallery/js/gallery-lightbox.js"></script>
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/web/js/preview.js packages/core/src/web/preview.html
git commit -m "feat(gallery): add list/grid toggle to preview page sidebar

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 16: End-to-End Verification & Fixes

**Files:**
- May touch any file above based on issues found

- [ ] **Step 1: Full build**

```bash
pnpm build
```
Expected: All 5 packages (core, mcp, ai, cli, gallery) build successfully.

- [ ] **Step 2: Start dev server and verify**

```bash
pnpm dev:start
```

Expected output includes `Gallery module loaded.` (if gallery available).

- [ ] **Step 3: Verify API endpoints**

```bash
# Gallery list (replace 1 with actual project ID)
curl -s http://localhost:27777/api/gallery/1?path= | head -c 200

# Thumbnails
curl -s -o /dev/null -w "%{http_code}" "http://localhost:27777/api/thumbnails/1?path=test.png&size=grid"

# Albums
curl -s http://localhost:27777/api/albums

# Capabilities
curl -s http://localhost:27777/api/capabilities | grep gallery
```

Expected: All endpoints return valid responses (200 or valid JSON).

- [ ] **Step 4: Verify gallery.html page**

Open `http://localhost:27777/gallery?project=1` in browser.
Expected: Full gallery page renders with sidebar, masonry grid, and functional lightbox.

- [ ] **Step 5: Verify preview.html grid toggle**

Open `http://localhost:27777/preview.html` with a project containing images.
Expected: Grid toggle visible, clicking switches between list and grid views.

- [ ] **Step 6: Verify graceful degradation**

```bash
mv node_modules/.pnpm/@doc77+gallery@1.0.4/node_modules/@doc77/gallery /tmp/gallery-backup
```
Then restart server. Expected: Gallery capability shows `false`, existing image viewing works unchanged, no errors.

Restore gallery after test.

- [ ] **Step 7: Fix any issues found and commit**

```bash
git add -A
git commit -m "fix(gallery): end-to-end verification fixes

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 17: Write Tests

**Files:**
- Create: `packages/gallery/test/thumbnail.test.ts`
- Create: `packages/gallery/test/album.test.ts`
- Create: `packages/gallery/test/api.test.ts`

- [ ] **Step 1: Create thumbnail engine tests**

In `packages/gallery/test/thumbnail.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateThumbnail } from '../src/thumbnail/engine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('generateThumbnail', () => {
  it('creates a grid thumbnail from a test image', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-test-'));
    const testImg = path.join(tmpDir, 'test.png');

    // Create a minimal 100x100 red PNG using sharp
    const sharp = await import('sharp');
    await sharp.default({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } }
    }).png().toFile(testImg);

    const outDir = path.join(tmpDir, 'thumbnails');
    const result = await generateThumbnail(tmpDir, 'test.png', 1, 'grid', outDir);

    expect(result.cachePath).toContain('_grid.webp');
    expect(fs.existsSync(result.cachePath)).toBe(true);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Create album store tests**

In `packages/gallery/test/album.test.ts`:

```typescript
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
    expect(albums.length).toBe(1);
    expect(albums[0].name).toBe('Test Album');
  });

  it('updates an album', () => {
    const albums = listAlbums();
    updateAlbum(albums[0].id, { name: 'Updated Album' });
    const updated = listAlbums();
    expect(updated[0].name).toBe('Updated Album');
  });

  it('deletes an album', () => {
    const albums = listAlbums();
    deleteAlbum(albums[0].id);
    expect(listAlbums().length).toBe(0);
  });
});
```

- [ ] **Step 3: Create API integration tests**

In `packages/gallery/test/api.test.ts`:

```typescript
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
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } }
    }).png().toFile(path.join(thumbDir, 'blue.png'));
  });

  afterAll(() => {
    closeConnection();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    fs.rmSync(thumbDir, { recursive: true, force: true });
  });

  it('GET /api/gallery/:projectId returns media entries', async () => {
    const app = express();
    registerGalleryRoutes(app, { thumbnailsDir: thumbDir });

    // Simple supertest-like call
    const resp = await fetchFromApp(app, '/api/gallery/1?path=');
    expect(resp.entries).toBeDefined();
    expect(Array.isArray(resp.entries)).toBe(true);
  });
});

// Minimal fetch helper for express app testing
async function fetchFromApp(app: express.Application, url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${url}`)
        .then(r => r.json())
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @doc77/gallery test
```
Expected: All tests pass.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```
Expected: Existing tests still pass alongside new gallery tests.

- [ ] **Step 6: Commit**

```bash
git add packages/gallery/test/
git commit -m "test(gallery): add tests for thumbnail engine, album store, and API routes

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 18: Polish — gallery.html Full API Wiring

**Files:**
- Modify: `packages/gallery/src/web/gallery.html` (replace mock data with real API calls, wire lightbox and albums)

**Reference:** `docs/design/gallery_ui.html` lines 488-795 (complete JS)

- [ ] **Step 1: Wire real API calls in gallery.html**

Replace the mock data section and render logic in `gallery.html` with:

```javascript
// State
let state = {
  projectId: null,
  currentPath: '',
  items: [],
  offset: 0,
  limit: 100,
  total: 0,
  selectMode: false,
  selectedIds: new Set(),
  currentView: 'photos', // photos | timeline | videos | favorites | folder | album
};

async function init() {
  state.projectId = parseInt(new URLSearchParams(window.location.search).get('project'), 10);
  if (!state.projectId) {
    // Show project selector
    const projects = await (await fetch('/api/projects')).json();
    if (projects.length === 1) {
      state.projectId = projects[0].id;
    } else {
      // Render project picker
      return renderProjectPicker(projects);
    }
  }
  loadGallery();
}

async function loadGallery(path = '', resetOffset = true) {
  if (resetOffset) state.offset = 0;
  const resp = await fetch(
    `/api/gallery/${state.projectId}?path=${encodeURIComponent(path)}&offset=${state.offset}&limit=${state.limit}`
  );
  const data = await resp.json();
  state.items = resetOffset ? data.entries : [...state.items, ...data.entries];
  state.total = data.total;
  state.currentPath = path;

  const container = document.getElementById('gallery-container');
  window.GalleryCore.renderGrid(container, state.items, {
    grouped: true,
    projectId: state.projectId,
    onCardClick: (item) => {
      window.GalleryLightbox.open(item, state.items, state.projectId);
    },
  });
  window.GalleryCore.setupLazyLoading();
}

// Wire selection mode — reuse logic from UI reference lines 631-694
// Wire header buttons — view toggle, sort, select
// Wire sidebar — navigation items switch views, folders load from tree API, albums from album API

document.addEventListener('DOMContentLoaded', init);
```

- [ ] **Step 2: Wire sidebar folders to real tree API**

When a folder is clicked in the sidebar, call `/api/tree/:projectId?path=` to fetch subfolders and render them.

- [ ] **Step 3: Wire sidebar albums to real album API**

Use `window.GalleryAlbum.renderAlbumSidebar()` for album section.

- [ ] **Step 4: Verify visually**

Open gallery.html in browser with a test project containing images. Verify all interactions work: grid renders, lightbox opens, EXIF panel slides in, selection mode works, sidebar navigation switches views.

- [ ] **Step 5: Commit**

```bash
git add packages/gallery/src/web/gallery.html
git commit -m "feat(gallery): wire gallery.html with real API calls and interactive features

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

## Verification Checklist

After all tasks complete, verify end-to-end:

1. `pnpm build` — all packages build cleanly
2. `pnpm test` — all tests pass (existing + new gallery tests)
3. Start server: `pnpm dev:start` — Gallery module loaded in console
4. Open `http://localhost:27777` — Dashboard shows Gallery buttons on project cards
5. Open `http://localhost:27777/gallery?project=1` — Full gallery page renders
6. Click an image — Lightbox opens with navigation and EXIF panel
7. Toggle select mode — Batch operations toolbar appears
8. Create an album — Album appears in sidebar
9. Open preview.html — List/Grid toggle works
10. Disable gallery (`doc77 config set gallery.enabled false`) — Degrades gracefully
