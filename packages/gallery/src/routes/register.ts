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
export async function registerGalleryRoutes(app: Application, opts: GalleryOptions): Promise<void> {
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
    // Dynamic import since express is not a direct dependency of @doc77/gallery
    // and is expected to be available at runtime via the host application.
    const { static: staticMiddleware } = await import('express');
    app.use('/gallery', (req, _res, next) => {
      // Rewrite /gallery, /gallery/, /gallery/index.html to /gallery/gallery.html
      if (req.path === '/' || req.path === '/index.html' || req.path === '') {
        req.url = '/gallery.html';
      }
      next();
    }, staticMiddleware(webDir) as any);
  }
}
