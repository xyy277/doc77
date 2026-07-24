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
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
        { path: string } | undefined;
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
