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
         WHERE project_id = ? AND source_path LIKE ?`
      ).all(projectId, dirPath ? `${dirPath}%` : '%') as any[];

      // Group by month
      const groups: Map<string, { count: number; first: any }> = new Map();
      for (const row of rows) {
        const date = row.exif_date || row.source_mtime;
        if (!date) continue;
        const month = date.slice(0, 7); // YYYY-MM
        if (!groups.has(month)) {
          groups.set(month, { count: 0, first: row });
        }
        groups.get(month)!.count++;
      }

      const timeline: TimelineGroup[] = Array.from(groups.entries())
        .sort((a, b) => b[0].localeCompare(a[0])) // newest first
        .map(([label, data]) => {
          const [yearStr, monthStr] = label.split('-');
          const year = parseInt(yearStr, 10);
          const month = parseInt(monthStr, 10);
          const lastDay = new Date(year, month, 0).getDate();
          return {
            label,
            count: data.count,
            start_date: `${label}-01`,
            end_date: `${label}-${String(lastDay).padStart(2, '0')}`,
            cover: {
              thumbnail_url: `/api/thumbnails/${projectId}?path=${encodeURIComponent(data.first.source_path)}&size=grid`,
              preview_url: `/api/thumbnails/${projectId}?path=${encodeURIComponent(data.first.source_path)}&size=preview`,
            },
          };
        });

      res.json({ groups: timeline });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}
