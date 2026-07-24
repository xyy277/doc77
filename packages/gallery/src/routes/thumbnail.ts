import * as path from 'node:path';
import * as fs from 'node:fs';
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
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
        { path: string } | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const result = await getOrGenerateThumbnail(
        project.path,
        filePath,
        projectId,
        size,
        opts.thumbnailsDir,
      );

      // Check if the generated file actually exists
      if (!fs.existsSync(result.cachePath)) {
        res
          .status(500)
          .json({ error: 'Thumbnail file not found after generation: ' + result.cachePath });
        return;
      }

      // Use readFileSync + send instead of sendFile for Express 5 compatibility
      const buf = fs.readFileSync(result.cachePath);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.contentType('image/webp');
      res.send(buf);
    } catch (e: any) {
      console.error('[gallery] thumbnail error:', e.message || e);
      res.status(500).json({ error: e.message || String(e) });
    }
  };
}
