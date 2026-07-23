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
  app.get('/api/thumbnails/:projectId', (req, res, next) => {
    thumbHandler(req, res).catch(next);
  });
  app.get('/api/exif/:projectId', (req, res, next) => {
    exif(req, res).catch(next);
  });

  // Diagnostic route — verify Express routing works
  app.get('/api/thumbnails/ping', (_req, res) => {
    res.json({ ok: true, time: Date.now() });
  });

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
    const galleryHtmlPath = path.join(webDir, 'gallery.html');

    // Serve /gallery and /gallery.html as GET routes (reliable across Express versions)
    app.get('/gallery', (_req, res) => {
      if (fs.existsSync(galleryHtmlPath)) {
        res.sendFile(galleryHtmlPath);
      } else {
        res.status(404).type('html').send('<h1>Gallery page not found</h1>');
      }
    });
    app.get('/gallery.html', (_req, res) => {
      if (fs.existsSync(galleryHtmlPath)) {
        res.sendFile(galleryHtmlPath);
      } else {
        res.status(404).type('html').send('<h1>Gallery page not found</h1>');
      }
    });

    // Serve static JS/CSS assets under /gallery/
    const { static: staticMiddleware } = await import('express');
    app.use('/gallery', staticMiddleware(webDir));
  }
}
