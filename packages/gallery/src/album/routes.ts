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
