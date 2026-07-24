import express, { type Request, type Response, type NextFunction } from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { exec, execSync } from 'node:child_process';
import { openDirectoryDialog } from './dialog.js';
import { fileURLToPath } from 'node:url';
import { getConnection } from '../db/connection.js';
import { discoverProjects } from '../scanner/discover.js';
import {
  detectProjectTags,
  discoverGitProjects,
  parseCodeWorkspace,
} from '../scanner/project-detector.js';
import {
  registerProject,
  listProjects,
  removeProject,
  updateProject,
  touchProject,
} from '../db/projects.js';
import { scanDirectory, clearCache } from '../scanner/index.js';
import {
  readFile,
  readFileRaw,
  isBinaryFile,
  readFirstNLines,
  validatePath,
  resolveProjectPath,
  isSensitiveFile,
} from '../fs/index.js';
import * as crypto from '../crypto.js';
import {
  renderMarkdown,
  renderMermaid,
  renderCode,
  getRendererForFile,
  isUnsupportedFormat,
  FORMAT_SIZE_LIMITS,
} from '../renderers/index.js';
import { getOrCreateSession, resetSession, type SessionAgent } from './sessions.js';
import { executeAiWriteTool, isAiWriteTool, type AiWriteFns } from './ai-tools.js';
import { createRateLimiter } from './rate-limit.js';
import { saveAiSession, loadAiSession } from '../db/ai-sessions.js';
import { isMobileRequest } from './mobile-detect.js';
import * as auth from './auth.js';
import { getMobileInfo, publishMdns } from './mobile-mdns.js';
import { installElectronModule } from './electron-install.js';

import { VERSION } from '../version.gen.js';
import { getConfig } from '../db/config.js';
import { initI18n, t } from '../i18n/index.js';
import { buildI18nResponse } from './i18n-route.js';
import { bundleHTML, ShareManager } from '../export/index.js';
import { getLocalIP, getLocalIPs, renderSharePage, renderShareError } from '../export/helpers.js';
import QRCode from 'qrcode';

/** Lazy import from @doc77/mcp — optional peer dep, may not be installed */
async function auditLog(entry: Record<string, unknown>) {
  try {
    const { writeAuditLog } = await import('@doc77/mcp');
    writeAuditLog(entry as any);
  } catch {
    /* mcp not installed - skip audit log */
  }
}

// Module capabilities — set by CLI layer at startup
let _capabilities = { ai: false, mcp: false, translate: false, gallery: false };
export function setCapabilities(caps: {
  ai: boolean;
  mcp: boolean;
  translate: boolean;
  gallery: boolean;
}) {
  _capabilities = { ..._capabilities, ...caps };
}

// Server info — populated by CLI layer at startup for share link construction
let _serverInfo = { bind: '0.0.0.0', port: 27777 };
export function setServerInfo(info: { bind: string; port: number }) {
  _serverInfo = info;
}
function getServerInfo() {
  return _serverInfo;
}

/**
 * Create and configure the Express application.
 * @param restartCallback — if provided, enables POST /api/restart endpoint
 * @param bindAddr — actual runtime bind address (for /api/server-info)
 * @param port — actual runtime port (for /api/server-info)
 * @param eventBus — optional EventBus for file-tree:changed SSE events
 */
export function createApp(
  restartCallback?: () => void,
  bindAddr?: string,
  port?: number,
  eventBus?: {
    on(event: string, listener: (p: unknown) => void): void;
    off(event: string, listener: (p: unknown) => void): void;
    emit(event: string, payload: unknown): void;
  },
) {
  const app = express();

  // Sync runtime bind/port to _serverInfo so share URL construction uses correct values
  setServerInfo({
    bind: bindAddr || '127.0.0.1',
    port: port || 27777,
  });

  // Initialize i18n from global config (empty config = auto-detect system language)
  initI18n(getConfig('locale.language') || '');

  // --- Middleware ---

  // Parse JSON bodies
  app.use(express.json({ limit: '5mb' }));

  // LAN access control — collect local IPs at startup
  const _localIPs: Set<string> = getLocalIPs();
  function lanRestrict(req: Request, res: Response, next: NextFunction): void {
    let enabled: string | undefined;
    try {
      enabled = getConfig('security.lan_restrict');
    } catch {
      // DB not ready — allow access
      return next();
    }
    if (enabled !== 'true') return next();
    const remoteIp = req.socket.remoteAddress || '';
    if (_localIPs.has(remoteIp)) return next();
    res.status(403).json({ error: t('api.lanRestricted'), code: 'LAN_RESTRICTED' });
  }

  // Share manager — manages share token lifecycle and cleanup
  const shareManager = new ShareManager();

  // === Resolve web directory (unchanged logic) ===
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const webCandidates = [
    path.join(moduleDir, 'web'), // dist/web/ (npm publish layout)
    path.join(moduleDir, '..', 'web'), // src/web/ (dev via src/server/)
    path.join(moduleDir, '..', 'src', 'web'), // resolve from dist/ to src/web/
  ];
  let webDir = '';
  for (const candidate of webCandidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      webDir = candidate;
      break;
    }
  }

  // === Fallback HTML (extracted from original inline) ===
  const fallbackHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Doc77</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc">
<div style="text-align:center">
<h1 style="color:#1e293b;font-size:2rem;margin-bottom:.5rem">📁 Doc77</h1>
<p style="color:#64748b">Dashboard is running.</p>
<p style="color:#94a3b8;font-size:14px">Run <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px">pnpm build</code> in the workspace root to rebuild the web assets.</p>
</div></body></html>`;

  // === Device-aware HTML routes (must be before static middleware) ===

  app.get('/', (_req: Request, res: Response) => {
    if (!webDir) {
      res.type('html').send(fallbackHtml);
      return;
    }
    const useMobile = isMobileRequest(_req);
    const target = path.join(webDir, useMobile ? 'mobile/index.html' : 'index.html');
    if (fs.existsSync(target)) {
      res.sendFile(target, { dotfiles: 'allow' });
      return;
    }
    // Graceful degradation: fall back to desktop if mobile HTML missing
    if (useMobile) {
      const desktopFallback = path.join(webDir, 'index.html');
      if (fs.existsSync(desktopFallback)) {
        res.sendFile(desktopFallback, { dotfiles: 'allow' });
        return;
      }
    }
    res.type('html').send(fallbackHtml);
  });

  app.get('/guide', (_req: Request, res: Response) => {
    if (!webDir) {
      res.status(404).type('html').send('<h1>Not Found</h1>');
      return;
    }
    const target = path.join(webDir, 'guide.html');
    if (fs.existsSync(target)) {
      res.sendFile(target, { dotfiles: 'allow' });
      return;
    }
    res.status(404).type('html').send('<h1>Not Found</h1>');
  });

  app.get('/preview.html', (_req: Request, res: Response) => {
    if (!webDir) {
      res.status(404).type('html').send('<h1>Not Found</h1>');
      return;
    }
    const useMobile = isMobileRequest(_req);
    const target = path.join(webDir, useMobile ? 'mobile/preview.html' : 'preview.html');
    if (fs.existsSync(target)) {
      res.sendFile(target, { dotfiles: 'allow' });
      return;
    }
    if (useMobile) {
      const desktopFallback = path.join(webDir, 'preview.html');
      if (fs.existsSync(desktopFallback)) {
        res.sendFile(desktopFallback, { dotfiles: 'allow' });
        return;
      }
    }
    res.status(404).type('html').send('<h1>Not Found</h1>');
  });

  // === Static file serving (after explicit routes) ===

  if (webDir) {
    // /mobile/* → web/mobile/ files (conditional — no error if dir missing)
    const mobileDir = path.join(webDir, 'mobile');
    if (fs.existsSync(mobileDir)) {
      app.use('/mobile', express.static(mobileDir));
    }
    // /* → desktop + shared assets (catch-all)
    app.use(express.static(webDir));
  }

  // Serve vendor cache (offline CDN resources).
  // Electron: bundled in resources/vendor/ (via extraResources).
  // CLI / dev: ~/.doc77/vendor/ (populated by `doc77 vendor-install`).
  const vendorDir = process.env.DOC77_ELECTRON
    ? process.env.DOC77_VENDOR_DIR || path.join(process.resourcesPath!, 'vendor')
    : path.join(process.env.HOME || '/home', '.doc77', 'vendor');
  app.use('/vendor', express.static(vendorDir, { fallthrough: true, dotfiles: 'allow' }));

  // CORS — allow all origins (localhost-only binding for security)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // --- mDNS publisher for mobile companion discovery ---
  let mdnsService: { destroy: () => void } | null = null;
  if (port) {
    publishMdns(port).then((s) => {
      mdnsService = s;
    });
  }

  // --- API Routes ---

  // i18n dictionary delivery (with ETag caching)
  app.get('/api/i18n', (req: Request, res: Response) => {
    const r = buildI18nResponse({
      lang: String(req.query.lang || ''),
      hint: String(req.query.hint || ''),
      global: getConfig('locale.language') || '',
    });
    if (req.headers['if-none-match'] === r.etag) {
      res.status(304).end();
      return;
    }
    res.set('ETag', r.etag);
    res.json({ lang: r.lang, dict: r.dict, available: r.available, global: r.global });
  });

  // Server info — runtime state (actual bind address, not config)
  app.get('/api/server-info', async (req: Request, res: Response) => {
    const addr = bindAddr || '127.0.0.1';
    const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === 'localhost';
    const isElectron = process.env.DOC77_ELECTRON === '1';
    const info: Record<string, unknown> = {
      version: VERSION,
      port: port || 27777,
      bindAddress: addr,
      isLocal,
      runningIn: isElectron ? 'electron' : 'cli',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      isWsl: !!process.env.WSL_DISTRO_NAME,
      hostOverride: getConfig('share.host_override') || '',
      lanRestrict: getConfig('security.lan_restrict') === 'true',
      isLocalRequest: _localIPs.has(req.socket.remoteAddress || ''),
    };
    // When bound to all interfaces, expose the LAN IP so frontends
    // (especially Electron's BrowserWindow, which loads localhost) can
    // generate correct QR codes and URLs for other devices on the network.
    if (addr === '0.0.0.0') {
      info.lanIp = getLocalIP();
    }
    if (isElectron) (info as any).electronVersion = process.versions.electron || null;
    try {
      const db = getConnection();
      const authRow = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as
        { password_hash: string } | undefined;
      const projectCount = (
        db.prepare('SELECT COUNT(*) as cnt FROM projects').get() as { cnt: number }
      ).cnt;
      info.projectCount = projectCount;
      info.capabilities = _capabilities;
    } catch {
      /* non-critical */
    }
    // Version update check — best-effort, cached for 5 min
    try {
      const { checkForUpdate } = await import('../update/index.js');
      const u = await checkForUpdate();
      if (u) {
        info.latestVersion = u.latest;
        info.hasUpdate = u.hasUpdate;
        info.releaseUrl = u.htmlUrl;
      }
    } catch {
      /* /api/server-info must never fail because of the update check */
    }
    res.json(info);
  });

  // Mobile info — device info for companion app discovery
  app.get('/api/mobile/info', (_req: Request, res: Response) => {
    res.json(getMobileInfo(port || 27777));
  });

  // Module capabilities
  app.get('/api/capabilities', (_req: Request, res: Response) => {
    res.json(_capabilities);
  });

  // Electron: one-click install for AI/MCP/translate modules
  if (process.env.DOC77_ELECTRON) {
    app.post('/api/electron/install', async (req: Request, res: Response) => {
      const mod = (req.body.module as string) || '';
      if (!['ai', 'mcp', 'translate'].includes(mod)) {
        res.status(400).json({ error: 'invalid module' });
        return;
      }
      try {
        const { message } = await installElectronModule(mod);
        res.json({ ok: true, message });
      } catch (e: unknown) {
        res.status(500).json({ error: (e as Error).message });
      }
    });
  }

  // Server restart (only when callback provided)
  if (restartCallback) {
    app.post('/api/restart', (_req: Request, res: Response) => {
      res.json({ ok: true, message: 'Server restarting...' });
      // Delay restart to allow response to be sent
      setTimeout(() => restartCallback(), 500);
    });
  }

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    let dbStatus = 'connected';
    let activeLocks = 0;
    let sessionCount = 0;
    try {
      const db = getConnection();
      activeLocks = (
        db.prepare('SELECT COUNT(*) as count FROM project_locks').get() as { count: number }
      ).count;
      sessionCount = (
        db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
      ).count;
    } catch {
      dbStatus = 'disconnected';
    }

    res.json({
      status: 'ok',
      version: VERSION,
      db: dbStatus,
      active_locks: activeLocks,
      session_count: sessionCount,
      timestamp: new Date().toISOString(),
    });
  });

  // Dashboard statistics
  app.get('/api/stats', (_req: Request, res: Response) => {
    try {
      const db = getConnection();
      const projects = (
        db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }
      ).count;
      const lastActiveRow = db
        .prepare(
          "SELECT COALESCE(MAX(strftime('%s',last_opened)), MAX(strftime('%s',created_at))) as last_active FROM projects",
        )
        .get() as { last_active: number | null };
      const favoriteCount = (
        db.prepare('SELECT COUNT(*) as count FROM favorites').get() as { count: number }
      ).count;

      res.json({
        projects,
        lastActive: lastActiveRow?.last_active ? Number(lastActiveRow.last_active) * 1000 : null,
        favoriteCount,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Record a file view
  app.post('/api/recent-files', (req: Request, res: Response) => {
    const { projectId, fileName, filePath } = req.body;
    if (!projectId || !fileName || !filePath) {
      res.status(400).json({ error: 'projectId, fileName, and filePath are required' });
      return;
    }

    try {
      const db = getConnection();

      // Verify project exists
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Dedup: remove old entry for same project+file, then insert fresh
      db.prepare('DELETE FROM recent_files WHERE project_id = ? AND file_path = ?').run(
        projectId,
        filePath,
      );
      db.prepare(
        'INSERT INTO recent_files (project_id, file_name, file_path) VALUES (?, ?, ?)',
      ).run(projectId, fileName, filePath);

      // Enforce max 50 records
      db.prepare(
        `DELETE FROM recent_files WHERE id NOT IN (
          SELECT id FROM recent_files ORDER BY viewed_at DESC LIMIT 50
        )`,
      ).run();

      res.status(201).json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Get recent files
  app.get('/api/recent-files', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 5, 20);

    try {
      const db = getConnection();
      const rows = db
        .prepare(
          `SELECT rf.file_name, rf.file_path, rf.project_id, strftime('%s',rf.viewed_at) as viewed_ts, p.name as project_name
         FROM recent_files rf
         JOIN projects p ON p.id = rf.project_id
         ORDER BY rf.viewed_at DESC
         LIMIT ?`,
        )
        .all(limit) as Array<{
        file_name: string;
        file_path: string;
        project_id: number;
        viewed_ts: number;
        project_name: string;
      }>;

      res.json(
        rows.map((r) => ({
          fileName: r.file_name,
          filePath: r.file_path,
          projectId: r.project_id,
          projectName: r.project_name,
          viewedAt: Number(r.viewed_ts) * 1000,
        })),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Project auto-discovery
  app.get('/api/discover', lanRestrict, (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || '~';
    const depth = parseInt(req.query.depth as string, 10) || 2;

    // Security: reject blocked roots
    const blocked = [
      '/etc',
      '/sys',
      '/proc',
      '/dev',
      '/boot',
      '/run',
      '/bin',
      '/sbin',
      '/usr',
      '/var',
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ];
    const expanded = dirPath.startsWith('~') ? os.homedir() + dirPath.slice(1) : dirPath;
    const resolved = path.resolve(expanded).replace(/\\/g, '/');
    for (const b of blocked) {
      const bn = b.replace(/\\/g, '/');
      if (resolved === bn || resolved.startsWith(bn + '/')) {
        res.status(400).json({ error: t('api.scan.dirNotAllowed'), code: 'SCAN_DIR_NOT_ALLOWED' });
        return;
      }
    }

    try {
      // Collect already-registered paths for dedup
      const db = getConnection();
      const registered = db.prepare('SELECT path FROM projects').all() as { path: string }[];
      const existingPaths = new Set(registered.map((r) => path.resolve(r.path)));

      const results = discoverProjects(dirPath, Math.min(depth, 5), existingPaths);
      res.json(results);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Git project discovery
  app.get('/api/discover/git', lanRestrict, (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || os.homedir();
    const depth = Math.min(5, Math.max(2, parseInt(req.query.depth as string, 10) || 3));

    try {
      const repos = discoverGitProjects(dirPath, depth);
      // Filter out already-registered paths
      const existingPaths = new Set(listProjects().map((p) => path.resolve(p.path)));
      const filtered = repos.filter((r) => !existingPaths.has(r.path));

      res.json({ root: dirPath, repositories: filtered, count: filtered.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // Import VS Code workspace
  app.post('/api/projects/import-workspace', lanRestrict, (req: Request, res: Response) => {
    const { workspacePath } = req.body;
    if (!workspacePath) {
      res.status(400).json({ error: 'workspacePath is required' });
      return;
    }

    try {
      const folders = parseCodeWorkspace(workspacePath);
      if (!folders.length) {
        res
          .status(400)
          .json({ error: t('api.import.invalidWorkspace'), code: 'INVALID_WORKSPACE' });
        return;
      }

      const existingPaths = new Set(listProjects().map((p) => p.path));
      const imported: Array<{ path: string; name: string; tags: string[]; id?: number }> = [];
      const skipped: string[] = [];

      for (const folder of folders) {
        if (existingPaths.has(folder.path)) {
          skipped.push(folder.name);
          continue;
        }
        try {
          const tags = detectProjectTags(folder.path);
          const project = registerProject(folder.name, folder.path, false, tags);
          imported.push({ path: folder.path, name: folder.name, tags, id: project.id });
          existingPaths.add(folder.path);
        } catch {
          // skip individual failures
        }
      }

      res.json({ workspacePath, imported, skipped, count: imported.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // Project CRUD
  app.get('/api/projects', (_req: Request, res: Response) => {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.path, p.created_at, p.last_opened,
              p.obsidian_mode, p.tags,
              CASE WHEN f.project_id IS NOT NULL THEN 1 ELSE 0 END as favorited
       FROM projects p
       LEFT JOIN favorites f ON f.project_id = p.id
       ORDER BY p.name`,
      )
      .all() as any[];
    const projects = rows.map((r) => ({
      ...r,
      obsidian_mode: !!r.obsidian_mode,
      tags: (() => {
        try {
          return JSON.parse(r.tags || '[]');
        } catch {
          return [];
        }
      })(),
    }));
    res.json(projects);
  });

  app.post('/api/projects', lanRestrict, (req: Request, res: Response) => {
    const { name, path: projectPath, obsidian_mode, tags } = req.body;
    if (!name || !projectPath) {
      res.status(400).json({ error: 'name and path are required' });
      return;
    }
    try {
      const resolved = resolveProjectPath(projectPath);
      const finalTags = tags || detectProjectTags(resolved);
      const project = registerProject(name, resolved, Boolean(obsidian_mode), finalTags);
      res.status(201).json(project);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(409).json({ error: message });
    }
  });

  app.delete('/api/projects/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    const removed = removeProject(id);
    if (!removed) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ removed: true });
  });

  // Update project
  app.put('/api/projects/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const { name, path: newPath, obsidian_mode, tags } = req.body;
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!name && !newPath && obsidian_mode === undefined && tags === undefined) {
      res.status(400).json({ error: 'name, path, obsidian_mode, or tags required' });
      return;
    }
    try {
      const resolved = newPath ? resolveProjectPath(newPath) : undefined;
      updateProject(id, { name, path: resolved, obsidian_mode, tags });
      res.json({ ok: true });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      res.status(409).json({ error: message });
    }
  });

  // Touch project (update last_opened)
  app.post('/api/projects/:id/touch', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    touchProject(id);
    res.json({ ok: true });
  });

  // Toggle project favorite
  app.put('/api/projects/:id/favorite', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }

    try {
      const db = getConnection();

      // Verify project exists
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Check current favorite status
      const existing = db.prepare('SELECT * FROM favorites WHERE project_id = ?').get(id);

      if (existing) {
        db.prepare('DELETE FROM favorites WHERE project_id = ?').run(id);
        res.json({ id, favorited: false });
      } else {
        db.prepare('INSERT INTO favorites (project_id) VALUES (?)').run(id);
        res.json({ id, favorited: true });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Environment detection — tells frontend what strategies are available
  app.get('/api/env', (_req: Request, res: Response) => {
    let wsl = false;
    try {
      wsl = /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf-8'));
    } catch {}
    const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    res.json({
      platform: process.platform,
      wsl,
      hasDisplay,
      home: process.env.HOME || '/home',
      username: process.env.USER || '',
    });
  });

  // Fingerprint-based folder finder — matches a directory picked by the browser
  // against the server's local filesystem
  app.post('/api/find-folder', async (req: Request, res: Response) => {
    const { folderName, fingerprint } = req.body as {
      folderName?: string;
      fingerprint?: Array<{ name: string; size: number; type: string }>;
    };
    if (!folderName || !fingerprint || fingerprint.length === 0) {
      res.status(400).json({ error: 'folderName and fingerprint are required' });
      return;
    }

    // Determine search roots — Linux home first (fast), then Windows mounts
    const searchRoots: string[] = [];
    const home = process.env.HOME || '/home';
    searchRoots.push(home);
    let isWsl = false;
    try {
      isWsl = /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf-8'));
    } catch {}
    if (isWsl) {
      for (const drive of ['d', 'c', 'e']) {
        try {
          if (fs.existsSync('/mnt/' + drive)) searchRoots.push('/mnt/' + drive);
        } catch {}
      }
      try {
        const usersDir = '/mnt/c/Users';
        for (const e of fs.readdirSync(usersDir, { withFileTypes: true })) {
          if (
            e.isDirectory() &&
            !e.isSymbolicLink() &&
            !['Public', 'Default', 'Default User', 'All Users', 'WsiAccount'].includes(e.name) &&
            !e.name.startsWith('.')
          ) {
            searchRoots.push(usersDir + '/' + e.name);
          }
        }
      } catch {}
    }

    const matches: Array<{ path: string; score: number }> = [];
    const deadline = Date.now() + 5000;

    for (const root of searchRoots) {
      if (Date.now() > deadline) break;
      try {
        const raw = (() => {
          try {
            return execSync(
              `find "${root}" -maxdepth 4 -type d -name "${folderName}" 2>/dev/null; true`,
              { timeout: 4000, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
            ).trim();
          } catch (e: unknown) {
            // execSync throws on non-zero exit, but stdout may still have results
            const err = e as { stdout?: string; stderr?: string };
            return (err.stdout || '').trim();
          }
        })();
        const candidates = raw.split('\n').filter(Boolean);
        for (const candidate of candidates) {
          if (Date.now() > deadline) break;
          try {
            // Match all fingerprint entries (files + directories)
            let matched = 0,
              checked = 0;
            for (const fp of fingerprint) {
              checked++;
              try {
                const fpPath = candidate + '/' + fp.name;
                const st = fs.statSync(fpPath);
                if (fp.type === 'directory' && st.isDirectory()) {
                  matched++;
                } else if (fp.type === 'file' && st.isFile()) {
                  if (fp.size === 0 || st.size === fp.size || Math.abs(st.size - fp.size) < 10)
                    matched++;
                }
              } catch {}
            }
            const score = checked > 0 ? matched / checked : 0;
            if (score > 0) {
              matches.push({ path: candidate, score });
            }
          } catch {}
        }
      } catch {}
    }

    // Sort by score descending, deduplicate
    matches.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const unique = matches.filter((m) => {
      if (seen.has(m.path)) return false;
      seen.add(m.path);
      return true;
    });

    res.json({ matches: unique.slice(0, 5) });
  });

  // Server-side file browser — for remote access or when native dialog unavailable
  app.get('/api/browse-fs', lanRestrict, (req: Request, res: Response) => {
    let dirPath = (req.query.path as string) || '/';
    // Expand ~ and resolve
    if (dirPath.startsWith('~')) {
      dirPath = (process.env.HOME || '/home') + dirPath.slice(1);
    }
    dirPath = path.resolve(dirPath);

    // Determine if request comes from localhost (even when bound to 0.0.0.0)
    const remoteIp = req.socket.remoteAddress || '';
    const isLocalRequest =
      remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    const isLocalBind =
      !bindAddr || bindAddr === '127.0.0.1' || bindAddr === 'localhost' || bindAddr === '::1';
    const isLocalAccess = isLocalBind || isLocalRequest;

    // WSL /mnt blocking — only relevant on Linux, and only for remote access
    const isLinux = process.platform === 'linux';
    const isMntPath = isLinux && (dirPath === '/mnt' || dirPath.startsWith('/mnt/'));
    if (!isLocalAccess && isMntPath) {
      res.json({
        path: dirPath,
        parent: null,
        roots: ['/home', '/tmp'],
        entries: [],
        error: t('api.fs.mntNotAllowed'),
        code: 'FS_MNT_NOT_ALLOWED',
      });
      return;
    }

    // Security: blacklist system directories per OS, allow everything else.
    // Password protection is the primary security layer for remote access.
    const isWin = process.platform === 'win32';
    function isPathBlocked(p: string): boolean {
      const BLOCKED_ROOTS: Record<string, string[]> = {
        win32: [
          'C:\\Windows',
          'C:\\Program Files',
          'C:\\Program Files (x86)',
          'C:\\ProgramData',
          'C:\\$Recycle.Bin',
          'C:\\System Volume Information',
          'C:\\Recovery',
          'C:\\Config.Msi',
          'C:\\MSOCache',
          'C:\\PerfLogs',
        ],
        linux: [
          '/etc',
          '/proc',
          '/sys',
          '/dev',
          '/run',
          '/boot',
          '/var/log',
          '/var/run',
          '/var/lock',
          '/bin',
          '/sbin',
          '/usr/bin',
          '/usr/sbin',
        ],
        darwin: ['/System', '/Library', '/private/etc', '/private/var', '/usr/bin', '/usr/sbin'],
      };
      const blocked = BLOCKED_ROOTS[process.platform] || [];
      return blocked.some((r) => p === r || p.startsWith(r + path.sep));
    }
    if (isPathBlocked(dirPath)) {
      res.json({
        path: dirPath,
        parent: null,
        roots: [],
        entries: [],
        error: t('api.fs.dirNotAllowed'),
        code: 'FS_DIR_NOT_ALLOWED',
      });
      return;
    }

    // Hidden system dirs to filter from root-level listings only
    const BLOCKED_DIRS = isWin
      ? new Set([
          'Windows',
          'Program Files',
          'Program Files (x86)',
          'ProgramData',
          '$Recycle.Bin',
          'System Volume Information',
          'Recovery',
          'Config.Msi',
          'MSOCache',
          'PerfLogs',
        ])
      : new Set([
          'etc',
          'proc',
          'sys',
          'root',
          'var',
          'boot',
          'dev',
          'run',
          'snap',
          'bin',
          'sbin',
          'lib',
          'lib64',
          'usr',
          'lost+found',
          '.dockerenv',
        ]);

    // Cross-platform root detection (C:\ on Windows, / on Unix)
    const parsedRoot = path.parse(dirPath).root;
    const isRoot = parsedRoot === dirPath;

    // Security: verify the path exists and is a directory
    let entries: Array<{ name: string; type: string; size: number }> = [];
    let error: string | undefined;
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        error = 'Not a directory';
      } else {
        const raw = fs.readdirSync(dirPath, { withFileTypes: true });
        entries = raw
          .filter((e) => !e.name.startsWith('.')) // hide dotfiles
          .filter(
            (e) =>
              !(
                isRoot &&
                (BLOCKED_DIRS.has(e.name) || e.name.includes('usr-is-merged') || e.name === 'init')
              ),
          )
          .filter((e) => !(isRoot && !isLocalAccess && isLinux && e.name === 'mnt')) // hide /mnt in remote mode
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            size: 0,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 200); // cap entries
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : 'Access denied';
    }

    // Compute parent path
    const parent = path.dirname(dirPath);
    const hasParent = parent !== dirPath;

    // Quick-access root shortcuts (common user directories + drives)
    const roots: string[] = [];
    if (isWin) {
      const winHome = process.env.USERPROFILE || 'C:\\Users\\Default';
      if (fs.existsSync(winHome)) roots.push(winHome);
      // Common user folders
      for (const sub of ['Desktop', 'Documents', 'Downloads']) {
        const p = path.join(winHome, sub);
        try {
          if (fs.existsSync(p)) roots.push(p);
        } catch {}
      }
      // Available drives
      for (let c = 65; c <= 90; c++) {
        const drive = String.fromCharCode(c) + ':\\';
        try {
          if (fs.existsSync(drive)) roots.push(drive);
        } catch {}
      }
    } else {
      const home = process.env.HOME || '/home';
      if (fs.existsSync(home)) roots.push(home);
      // Common user folders
      for (const sub of ['Desktop', 'Documents', 'Downloads']) {
        const p = path.join(home, sub);
        try {
          if (fs.existsSync(p)) roots.push(p);
        } catch {}
      }
      // /tmp always available
      if (!roots.includes('/tmp')) roots.push('/tmp');
      // macOS specific
      if (process.platform === 'darwin' && !roots.includes('/Users')) roots.push('/Users');
      // WSL /mnt (local access only)
      if (isLocalAccess && isLinux) {
        try {
          const isWsl = /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf-8'));
          if (isWsl) {
            for (const drive of ['d', 'c', 'e']) {
              try {
                if (fs.existsSync('/mnt/' + drive)) roots.push('/mnt/' + drive);
              } catch {}
            }
          }
        } catch {}
      }
    }

    res.json({ path: dirPath, parent: hasParent ? parent : null, roots, entries, error });
  });

  // Native directory picker dialog
  app.post('/api/dialog/open-directory', lanRestrict, async (_req: Request, res: Response) => {
    try {
      const dirPath = await openDirectoryDialog();
      res.json({ path: dirPath });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Refresh tree cache for a project
  app.post('/api/tree/:id/refresh', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    try {
      clearCache(projectId);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // ── File Management CRUD ──

  // Helper: resolve project root and validate path
  function resolveAndValidate(projectId: number, reqPath: string): string {
    const db = getConnection();
    const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
      { path: string } | undefined;
    if (!project) throw new Error('Project not found');
    // validatePath returns the resolved absolute path, or throws on invalid
    return validatePath(project.path, reqPath);
  }

  // Validate file/folder name (no path separators, no traversal, reasonable length)
  function validateName(name: string): void {
    if (!name || name.trim().length === 0) throw new Error('Name cannot be empty');
    const trimmed = name.trim();
    if (trimmed.includes('/') || trimmed.includes('\\'))
      throw new Error('Name cannot contain path separators');
    if (trimmed === '..' || trimmed === '.') throw new Error('Invalid name');
    if (Buffer.byteLength(trimmed, 'utf8') > 255)
      throw new Error('Name is too long (max 255 bytes)');
  }

  // Emit file-tree:changed event if EventBus is available
  function emitTreeChanged(projectId: number, dirPath: string, opType: string): void {
    if (!eventBus) return;
    try {
      eventBus.emit('file-tree:changed', { projectId, path: dirPath, opType });
    } catch {
      /* best-effort */
    }
  }

  // Create empty file
  app.post('/api/tree/:id/file', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const dirPath = (req.query.path as string) || '';
    const { name } = req.body || {};

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    try {
      validateName(name);
      if (isSensitiveFile(name)) throw new Error('Sensitive file name is not allowed');
      const absDir = resolveAndValidate(projectId, dirPath);
      const absPath = path.join(absDir, name);
      if (fs.existsSync(absPath)) {
        res.status(409).json({ error: t('web.preview.error.nameConflict') });
        return;
      }
      fs.writeFileSync(absPath, '', 'utf8');
      clearCache(projectId, dirPath);
      emitTreeChanged(projectId, dirPath, 'create_file');
      res.json({ path: dirPath ? dirPath + '/' + name : name, type: 'file', size: 0 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const status = message.includes('not found')
        ? 404
        : message.includes('Sensitive')
          ? 403
          : message.includes('cannot be empty') ||
              message.includes('Invalid name') ||
              message.includes('too long') ||
              message.includes('path separators')
            ? 400
            : 500;
      res.status(status).json({ error: message });
    }
  });

  // Create folder
  app.post('/api/tree/:id/folder', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const dirPath = (req.query.path as string) || '';
    const { name } = req.body || {};

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    try {
      validateName(name);
      if (isSensitiveFile(name)) throw new Error('Sensitive file name is not allowed');
      const absDir = resolveAndValidate(projectId, dirPath);
      const absPath = path.join(absDir, name);
      if (fs.existsSync(absPath)) {
        res.status(409).json({ error: t('web.preview.error.nameConflict') });
        return;
      }
      fs.mkdirSync(absPath, { recursive: true });
      clearCache(projectId, dirPath);
      emitTreeChanged(projectId, dirPath, 'create_folder');
      res.json({ path: dirPath ? dirPath + '/' + name : name, type: 'directory' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const status = message.includes('not found')
        ? 404
        : message.includes('Sensitive')
          ? 403
          : message.includes('cannot be empty') ||
              message.includes('Invalid name') ||
              message.includes('too long') ||
              message.includes('path separators')
            ? 400
            : 500;
      res.status(status).json({ error: message });
    }
  });

  // Rename file or folder
  app.put('/api/tree/:id/rename', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const oldPath = (req.query.path as string) || '';
    const { newName } = req.body || {};

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!oldPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    if (!newName) {
      res.status(400).json({ error: 'newName is required' });
      return;
    }

    try {
      validateName(newName);
      const absOld = resolveAndValidate(projectId, oldPath);
      if (!fs.existsSync(absOld)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      if (isSensitiveFile(path.basename(absOld))) throw new Error('Cannot rename sensitive files');
      const oldName = path.basename(absOld);
      if (isSensitiveFile(newName)) throw new Error('Sensitive file name is not allowed');

      const absNew = path.join(path.dirname(absOld), newName);
      if (absOld === absNew) {
        res.json({ oldPath, newPath: oldPath });
        return;
      }
      if (fs.existsSync(absNew)) {
        res.status(409).json({ error: t('web.preview.error.nameConflict') });
        return;
      }

      fs.renameSync(absOld, absNew);
      const parentDir = path.dirname(oldPath);
      clearCache(projectId, parentDir === '.' ? '' : parentDir);
      // Also clear cache for the parent of the new path
      const newRelPath = parentDir === '.' ? newName : parentDir + '/' + newName;
      const newParent = path.dirname(newRelPath);
      clearCache(projectId, newParent === '.' ? '' : newParent);
      emitTreeChanged(projectId, parentDir === '.' ? '' : parentDir, 'rename');
      res.json({ oldPath, newPath: newRelPath });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const status = message.includes('not found')
        ? 404
        : message.includes('Sensitive') || message.includes('Cannot rename')
          ? 403
          : message.includes('cannot be empty') ||
              message.includes('Invalid name') ||
              message.includes('too long') ||
              message.includes('path separators')
            ? 400
            : 500;
      res.status(status).json({ error: message });
    }
  });

  // Delete file or folder
  app.delete('/api/tree/:id', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const targetPath = (req.query.path as string) || '';

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!targetPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    try {
      const absTarget = resolveAndValidate(projectId, targetPath);
      if (!fs.existsSync(absTarget)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const stat = fs.statSync(absTarget);
      const isDir = stat.isDirectory();
      if (isSensitiveFile(path.basename(absTarget)))
        throw new Error('Cannot delete sensitive files');

      // Safety: non-empty directories cannot be deleted
      if (isDir && fs.readdirSync(absTarget).length > 0) {
        res.status(400).json({ error: t('web.preview.error.dirNotEmpty') });
        return;
      }

      // Trash-based deletion: move to .doc77-trash for recovery
      const project = getConnection()
        .prepare('SELECT path FROM projects WHERE id = ?')
        .get(projectId) as { path: string } | undefined;
      const projectRoot = project!.path;
      const trashDir = path.join(projectRoot, '.doc77-trash');
      const timestamp = Date.now();
      const trashName = `${timestamp}-${path.basename(absTarget)}`;
      const trashPath = path.join(trashDir, trashName);

      let movedToTrash = false;
      try {
        fs.mkdirSync(trashDir, { recursive: true });
        fs.renameSync(absTarget, trashPath);
        movedToTrash = true;
      } catch {
        // Cross-device or trash failed — fall back to direct delete
        if (isDir) {
          fs.rmdirSync(absTarget);
        } else {
          fs.unlinkSync(absTarget);
        }
      }

      const parentDir = path.dirname(targetPath);
      clearCache(projectId, parentDir === '.' ? '' : parentDir);
      emitTreeChanged(projectId, parentDir === '.' ? '' : parentDir, 'delete');
      res.json({ path: targetPath, movedToTrash });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const status = message.includes('not found')
        ? 404
        : message.includes('Sensitive') || message.includes('Cannot delete')
          ? 403
          : 500;
      res.status(status).json({ error: message });
    }
  });

  // ── File Bookmarks ──

  // Get bookmarks for a project
  app.get('/api/tree/:id/bookmarks', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    try {
      const db = getConnection();
      const rows = db
        .prepare(
          'SELECT file_path, created_at FROM file_bookmarks WHERE project_id = ? ORDER BY created_at DESC',
        )
        .all(projectId) as Array<{ file_path: string; created_at: string }>;
      res.json({ bookmarks: rows.map((r) => ({ path: r.file_path, created_at: r.created_at })) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Toggle bookmark
  app.put('/api/tree/:id/bookmark', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const filePath = (req.query.path as string) || '';
    const { action } = req.body || {};
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    if (action !== 'add' && action !== 'remove') {
      res.status(400).json({ error: 'action must be "add" or "remove"' });
      return;
    }
    try {
      const db = getConnection();
      if (action === 'add') {
        db.prepare(
          'INSERT OR IGNORE INTO file_bookmarks (project_id, file_path) VALUES (?, ?)',
        ).run(projectId, filePath);
      } else {
        db.prepare('DELETE FROM file_bookmarks WHERE project_id = ? AND file_path = ?').run(
          projectId,
          filePath,
        );
      }
      res.json({ path: filePath, bookmarked: action === 'add' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Migrate bookmarks from localStorage to SQLite (idempotent)
  app.post('/api/tree/:id/bookmarks/migrate', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const { bookmarks } = req.body || {};
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!Array.isArray(bookmarks)) {
      res.status(400).json({ error: 'bookmarks must be an array' });
      return;
    }
    try {
      const db = getConnection();
      let imported = 0;
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO file_bookmarks (project_id, file_path, created_at) VALUES (?, ?, ?)',
      );
      for (const bm of bookmarks) {
        if (bm.path && typeof bm.path === 'string') {
          const createdAt = bm.time ? new Date(bm.time).toISOString() : new Date().toISOString();
          const result = stmt.run(projectId, bm.path, createdAt);
          if (result.changes > 0) imported++;
        }
      }
      res.json({ imported });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // ── Trash GC ──
  // Clean up .doc77-trash entries older than 30 days on server startup
  (function cleanupTrash() {
    try {
      const db = getConnection();
      const projects = db.prepare('SELECT id, path FROM projects').all() as Array<{
        id: number;
        path: string;
      }>;
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
      for (const proj of projects) {
        const trashDir = path.join(proj.path, '.doc77-trash');
        if (!fs.existsSync(trashDir)) continue;
        const entries = fs.readdirSync(trashDir);
        for (const entry of entries) {
          // Entry format: <timestamp>-<originalName>
          const match = entry.match(/^(\d{13})-/);
          if (match) {
            const ts = parseInt(match[1], 10);
            if (ts < cutoff) {
              const fullPath = path.join(trashDir, entry);
              try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                  fs.rmSync(fullPath, { recursive: true, force: true });
                } else {
                  fs.unlinkSync(fullPath);
                }
              } catch {
                /* best-effort cleanup */
              }
            }
          }
        }
      }
    } catch {
      /* best-effort cleanup on startup */
    }
  })();

  // Directory tree
  app.get('/api/tree/:id', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const dirPath = (req.query.path as string) || '';

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }

    try {
      const result = scanDirectory(projectId, dirPath);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // File content with renderer dispatch + safety gates
  app.get('/api/content/:id', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const filePath = req.query.path as string;

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    try {
      const db = getConnection();
      const project = db
        .prepare('SELECT path, obsidian_mode FROM projects WHERE id = ?')
        .get(projectId) as { path: string; obsidian_mode: number } | undefined;

      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const obsidianMode = project.obsidian_mode === 1;

      const absPath = validatePath(project.path, filePath);
      const stats = fs.statSync(absPath);
      const rendererType = getRendererForFile(filePath);

      // --- Safety Gate 1: Unsupported format ---
      if (isUnsupportedFormat(filePath)) {
        res.json({
          path: filePath,
          type: 'unsupported',
          size: stats.size,
          modified: stats.mtime.toISOString(),
          category: getFileCategory(filePath),
        });
        return;
      }

      // --- Safety Gate 2: Binary file detection ---
      if (rendererType === 'text' && isBinaryFile(absPath)) {
        res.json({
          path: filePath,
          type: 'unsupported',
          size: stats.size,
          modified: stats.mtime.toISOString(),
          category: 'binary',
        });
        return;
      }

      // --- Safety Gate 3: Size limit ---
      const sizeLimit = FORMAT_SIZE_LIMITS[rendererType] ?? FORMAT_SIZE_LIMITS.text;
      if (sizeLimit > 0 && stats.size > sizeLimit) {
        // For text-based formats: truncate and warn
        if (['markdown', 'mermaid', 'code', 'text'].includes(rendererType)) {
          const { content, truncated, totalBytes } = readFirstNLines(absPath, 10000);
          res.json({
            path: filePath,
            type: rendererType === 'text' ? 'text' : rendererType,
            content: truncated
              ? `${t('api.file.truncatedWarning', { size: (totalBytes / 1024 / 1024).toFixed(1) })}${content}`
              : content,
            truncated,
          });
          return;
        }
        // For xlsx: reject
        if (rendererType === 'xlsx') {
          res.json({
            path: filePath,
            type: 'unsupported',
            size: stats.size,
            modified: stats.mtime.toISOString(),
            category: 'too_large',
          });
          return;
        }
      }

      // --- Normal render ---
      switch (rendererType) {
        case 'markdown': {
          const raw = readFile(absPath);
          res.json({
            path: filePath,
            type: 'markdown',
            content: renderMarkdown(raw, { projectId, filePath, obsidianMode }),
            size: stats.size,
            modified: stats.mtime.toISOString(),
          });
          return;
        }
        case 'mermaid': {
          const raw = readFile(absPath);
          res.json({
            path: filePath,
            type: 'mermaid',
            content: renderMermaid(raw),
            size: stats.size,
            modified: stats.mtime.toISOString(),
          });
          return;
        }
        case 'code': {
          const raw = readFile(absPath);
          res.json({
            path: filePath,
            type: 'code',
            content: renderCode(raw, path.extname(filePath).slice(1)),
            rawUrl: `/api/raw/${projectId}?path=${encodeURIComponent(filePath)}`,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          });
          return;
        }
        case 'docx': {
          // docx is handled later (needs mammoth), for now return unsupported info
          res.json({
            path: filePath,
            type: 'docx',
            rawUrl: `/api/raw/${projectId}?path=${encodeURIComponent(filePath)}`,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          });
          return;
        }
        case 'xlsx': {
          res.json({
            path: filePath,
            type: 'xlsx',
            rawUrl: `/api/raw/${projectId}?path=${encodeURIComponent(filePath)}`,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          });
          return;
        }
        case 'image':
        case 'pdf':
          res.json({
            path: filePath,
            type: rendererType,
            rawUrl: `/api/raw/${projectId}?path=${encodeURIComponent(filePath)}`,
          });
          return;
        default: {
          const raw = readFile(absPath);
          res.json({ path: filePath, type: 'text', content: raw });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (
        message.includes('not found') ||
        message.includes('ENOENT') ||
        message.includes('traversal')
      ) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // ── Export: self-contained HTML ──

  app.post('/api/export/html', async (req: Request, res: Response) => {
    try {
      const { title, content, styles, images, theme, projectId } = req.body;

      if (!content || typeof content !== 'string') {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      // Require projectId for path validation
      if (!projectId) {
        res.status(400).json({ error: 'projectId is required' });
        return;
      }

      // Look up the project from the DB and resolve project root
      const db = getConnection();
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
        { path: string } | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const projectRoot = resolveProjectPath(project.path);

      // Resolve local images to base64 with path validation
      const resolvedImages: Array<{ url: string; base64: string }> = [];
      if (Array.isArray(images)) {
        for (const img of images) {
          if (!img.url || !img.path) continue;
          try {
            // Validate the image path against the project root
            const validatedPath = validatePath(projectRoot, img.path);
            const stats = fs.statSync(validatedPath);
            if (stats.size > 10 * 1024 * 1024) continue; // skip images over 10MB
            const data = fs.readFileSync(validatedPath);
            const ext = path.extname(validatedPath).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.svg': 'image/svg+xml',
              '.webp': 'image/webp',
              '.bmp': 'image/bmp',
              '.ico': 'image/x-icon',
            };
            const mime = mimeMap[ext] || 'application/octet-stream';
            resolvedImages.push({
              url: img.url,
              base64: `data:${mime};base64,${data.toString('base64')}`,
            });
          } catch {
            // Skip unresolvable images
          }
        }
      }

      const maxSize = parseInt(getConfig('export.html.maxFileSizeMB') || '10', 10);
      const htmlSizeKB = Math.round(
        (content.length + JSON.stringify(styles).length + JSON.stringify(images || []).length) /
          1024,
      );
      if (htmlSizeKB > maxSize * 1024) {
        res.status(413).json({
          error: t('api.export.tooLarge', {
            sizeMB: Math.round(htmlSizeKB / 1024),
            maxMB: maxSize,
          }),
          code: 'EXPORT_TOO_LARGE',
        });
        return;
      }

      const html = bundleHTML({
        title: title || 'untitled',
        content,
        styles: Array.isArray(styles) ? styles : [],
        images: resolvedImages,
        theme: theme === 'dark' ? 'dark' : 'light',
      });

      const safeFilename = (title || 'untitled').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_') + '.html';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
      );
      res.send(html);
    } catch (err: any) {
      res.status(500).json({ error: err.message || t('api.export.failed'), code: 'EXPORT_FAILED' });
    }
  });

  // ── Share: create, view, list, revoke ──

  /** POST /api/share — Create a share link */
  app.post('/api/share', (req: Request, res: Response) => {
    try {
      // Kill switch: check export.share.enabled
      if (getConfig('export.share.enabled') === 'false') {
        res.status(403).json({ error: t('api.share.disabled'), code: 'SHARE_DISABLED' });
        return;
      }

      const { projectId, filePath, title, theme } = req.body;
      if (!projectId || !filePath) {
        res.status(400).json({ error: 'projectId and filePath are required' });
        return;
      }

      // Check bind_address — sharing only works when bound to 0.0.0.0
      const effectiveBindAddr = bindAddr || '127.0.0.1';
      if (effectiveBindAddr === '127.0.0.1') {
        res.status(403).json({ error: t('api.share.bindRequired'), code: 'SHARE_BIND_REQUIRED' });
        return;
      }

      // Validate file through existing security chain
      const project = getProjectById(projectId);
      if (!project) {
        res.status(404).json({ error: t('api.project.notFound'), code: 'PROJECT_NOT_FOUND' });
        return;
      }
      const projectRoot = resolveProjectPath(project.path);
      const resolvedPath = validatePath(projectRoot, filePath);
      if (!resolvedPath) {
        res
          .status(404)
          .json({ error: t('api.share.pathOutsideProject'), code: 'PATH_OUTSIDE_PROJECT' });
        return;
      }
      if (isSensitiveFile(resolvedPath)) {
        res.status(403).json({ error: t('api.share.sensitiveFile'), code: 'SHARE_SENSITIVE_FILE' });
        return;
      }

      const ttlHours = parseInt(getConfig('export.share.ttl_hours') || '24', 10) || 24;
      const ttlMs = Math.min(Math.max(ttlHours, 1), 168) * 60 * 60 * 1000; // 1h min, 168h max

      const token = shareManager.create({
        projectId,
        filePath: resolvedPath,
        title: title || path.basename(filePath, path.extname(filePath)),
        theme: theme || 'light',
        ttlMs,
      });

      // Get the runtime bind address and port from server info
      const serverInfo = getServerInfo();
      // Host priority: share.host_override > LAN IP (when bind 0.0.0.0) > bind address
      const hostOverride = getConfig('share.host_override') || '';
      const shareHost =
        hostOverride || (serverInfo.bind === '0.0.0.0' ? getLocalIP() : serverInfo.bind);
      const shareUrl = `http://${shareHost}:${serverInfo.port}/s/${token.token}`;

      // Audit log
      auditLog({
        action: 'share:create',
        token: token.token,
        projectId,
        filePath: resolvedPath,
      });

      res.json({
        token: token.token,
        url: shareUrl,
        expiresAt: token.expiresAt,
        documentTitle: token.documentTitle,
      });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: err.message || t('api.share.createFailed'), code: 'SHARE_CREATE_FAILED' });
    }
  });

  /** GET /s/:token — Share page (read-only preview) */
  app.get('/s/:token', (req: Request, res: Response) => {
    const token = shareManager.validate(req.params.token);
    if (!token) {
      res.status(404).send(renderShareError(t('api.share.expired')));
      return;
    }
    res.send(renderSharePage(token));
  });

  /** GET /api/share/:token/data — Get rendered content for share page */
  app.get('/api/share/:token/data', (req: Request, res: Response) => {
    const token = shareManager.validate(req.params.token);
    if (!token) {
      res.status(404).json({ error: t('api.share.expired'), code: 'SHARE_EXPIRED' });
      return;
    }

    try {
      const content = readFile(token.filePath);
      const ext = path.extname(token.filePath).toLowerCase();
      const renderer = getRendererForFile(token.filePath);
      let rendered: { type: string; content: string; rawUrl?: string };

      if (renderer === 'markdown') {
        rendered = {
          type: 'markdown',
          content: renderMarkdown(content, {
            projectId: token.projectId,
            filePath: token.filePath,
          }),
        };
      } else if (renderer === 'code') {
        rendered = {
          type: 'code',
          content: renderCode(content, ext),
        };
      } else if (renderer === 'mermaid') {
        rendered = {
          type: 'mermaid',
          content: `<pre class="mermaid">${content}</pre>`,
        };
      } else if (renderer === 'image' || renderer === 'pdf') {
        rendered = {
          type: renderer,
          rawUrl: `/api/raw/${token.projectId}?path=${encodeURIComponent(token.filePath)}`,
          content: '',
        };
      } else {
        rendered = {
          type: 'text',
          content: `<pre class="text-sm whitespace-pre-wrap font-mono">${content}</pre>`,
        };
      }

      // Audit log the access
      auditLog({
        action: 'share:access',
        token: token.token,
        projectId: token.projectId,
        filePath: token.filePath,
      });

      res.json({ ...rendered, title: token.documentTitle, theme: token.theme });
    } catch (err: any) {
      res.status(500).json({ error: err.message || t('api.file.readFailed'), code: 'READ_FAILED' });
    }
  });

  /** GET /api/share/:token/qrcode — QR code SVG for share link */
  app.get('/api/share/:token/qrcode', async (req: Request, res: Response) => {
    const token = shareManager.validate(req.params.token);
    if (!token) {
      res.status(404).send('Token invalid or expired');
      return;
    }

    // Reconstruct the share URL (we don't store it, but we know the token)
    const serverInfo = getServerInfo();
    // Host priority: share.host_override > LAN IP (when bind 0.0.0.0) > bind address
    const hostOverride = getConfig('share.host_override') || '';
    const shareHost =
      hostOverride || (serverInfo.bind === '0.0.0.0' ? getLocalIP() : serverInfo.bind);
    const shareUrl = `http://${shareHost}:${serverInfo.port}/s/${token.token}`;

    try {
      const svg = await QRCode.toString(shareUrl, {
        type: 'svg',
        margin: 2,
        width: 300,
        color: { dark: '#1e293b', light: '#ffffff' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(svg);
    } catch (err: any) {
      res.status(500).json({ error: 'QR code generation failed' });
    }
  });

  /** GET /api/shares — List active share tokens */
  app.get('/api/shares', (_req: Request, res: Response) => {
    const shares = shareManager.list().map((t) => ({
      token: t.token,
      documentTitle: t.documentTitle,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      projectId: t.projectId,
      filePath: t.filePath,
    }));
    res.json(shares);
  });

  /** DELETE /api/share/:token — Revoke a share */
  app.delete('/api/share/:token', (req: Request, res: Response) => {
    const revoked = shareManager.revoke(req.params.token);
    if (revoked) {
      auditLog({ action: 'share:revoke', token: req.params.token });
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Token not found' });
    }
  });

  // --- Stateless render for temp drag-and-drop preview ---
  const BINARY_PREVIEW_EXTS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.webp',
    '.bmp',
    '.ico',
    '.avif',
    '.pdf',
    '.docx',
    '.xlsx',
  ]);

  app.post('/api/render-temp', async (req: Request, res: Response) => {
    const { filename, content } = req.body as { filename?: string; content?: string };

    if (!filename) {
      res.status(400).json({ error: 'filename is required' });
      return;
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' });
      return;
    }

    // Basename only — no path traversal risk
    const baseName = path.basename(filename);
    const ext = path.extname(baseName).toLowerCase();

    // Binary preview types must be rendered client-side via URL.createObjectURL
    if (BINARY_PREVIEW_EXTS.has(ext)) {
      res.status(400).json({ error: `binary preview type ${ext} — render client-side` });
      return;
    }

    // Null-byte detection (mirrors isBinaryFile in fs/index.ts)
    if (content.indexOf('\x00') !== -1) {
      res.json({ path: baseName, type: 'unsupported', category: 'binary', size: content.length });
      return;
    }

    // Unsupported format
    if (isUnsupportedFormat(baseName)) {
      res.json({
        path: baseName,
        type: 'unsupported',
        category: getFileCategory(baseName) || 'binary',
        size: content.length,
      });
      return;
    }

    const rendererType = getRendererForFile(baseName);

    // Size truncation — defensive, frontend gates before sending
    const sizeLimit = FORMAT_SIZE_LIMITS[rendererType] ?? FORMAT_SIZE_LIMITS.text;
    let renderContent = content;
    let truncated = false;
    if (sizeLimit > 0 && content.length > sizeLimit) {
      const lines = content.split('\n');
      if (lines.length > 10000) {
        renderContent = lines.slice(0, 10000).join('\n');
        truncated = true;
      }
    }

    const warn = truncated
      ? t('api.file.truncatedWarning', { size: (content.length / 1024 / 1024).toFixed(1) })
      : '';

    let result: Record<string, unknown>;

    switch (rendererType) {
      case 'markdown':
        result = {
          path: baseName,
          type: 'markdown',
          content: warn + renderMarkdown(renderContent),
          size: content.length,
        };
        break;
      case 'mermaid':
        result = {
          path: baseName,
          type: 'mermaid',
          content: warn + renderMermaid(renderContent),
          size: content.length,
        };
        break;
      case 'code':
        result = {
          path: baseName,
          type: 'code',
          content: renderCode(renderContent, ext.slice(1) || 'txt'),
          size: content.length,
        };
        break;
      default:
        result = { path: baseName, type: 'text', content: renderContent, size: content.length };
    }

    if (truncated) result.truncated = true;
    res.json(result);
  });

  // Save edited file content (lightweight editing)
  app.put('/api/content/:id', async (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const filePath = req.query.path as string;
    const { content } = req.body as { content?: string };
    const forceOverwrite = req.headers['x-force-overwrite'] === 'true';
    const expectedModified = req.headers['x-expected-modified'] as string | undefined;

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content body field is required' });
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

      // 1. Path validation
      const absPath = validatePath(project.path, filePath);

      // 2. Check editable file type (extension or dotfile basename)
      const ext = path.extname(filePath).toLowerCase();
      var baseName = path.basename(filePath);
      const editableExts = [
        '.md',
        '.mdx',
        '.txt',
        '.markdown',
        '.json',
        '.yaml',
        '.yml',
        '.toml',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.py',
        '.rb',
        '.go',
        '.rs',
        '.java',
        '.c',
        '.cpp',
        '.h',
        '.css',
        '.scss',
        '.less',
        '.html',
        '.htm',
        '.xml',
        '.svg',
        '.sh',
        '.bash',
        '.zsh',
        '.conf',
        '.cfg',
        '.ini',
        '.csv',
        '.log',
      ];
      const editableDotfiles = [
        '.gitignore',
        '.dockerignore',
        '.editorconfig',
        '.env.example',
        '.env',
      ];
      var isEditable = editableExts.includes(ext) || editableDotfiles.includes(baseName);
      if (!isEditable) {
        res
          .status(403)
          .json({ error: t('api.file.typeNotEditable'), code: 'EDIT_TYPE_NOT_ALLOWED' });
        return;
      }

      // 3. Sensitive file check
      if (isSensitiveFile(path.basename(filePath))) {
        res
          .status(403)
          .json({ error: t('api.file.sensitiveNotEditable'), code: 'EDIT_SENSITIVE_NOT_ALLOWED' });
        return;
      }

      // 4. File size check (read from config)
      const maxSizeMB = (() => {
        try {
          const row = db
            .prepare("SELECT value FROM config WHERE key = 'editor.maxFileSizeMB'")
            .get() as { value: string } | undefined;
          return row ? parseInt(row.value, 10) : 2;
        } catch {
          return 2;
        }
      })();
      const maxSizeBytes = maxSizeMB * 1024 * 1024;
      if (Buffer.byteLength(content, 'utf-8') > maxSizeBytes) {
        res
          .status(413)
          .json({ error: t('api.file.tooLarge', { maxSizeMB }), code: 'FILE_TOO_LARGE' });
        return;
      }

      // 5. Check existing file
      let existingStats: fs.Stats | null = null;
      let fileExists = false;
      try {
        existingStats = fs.statSync(absPath);
        fileExists = true;
      } catch {}

      // 6. External change detection
      if (fileExists && expectedModified && !forceOverwrite) {
        if (Math.abs(existingStats!.mtimeMs - new Date(expectedModified).getTime()) > 1000) {
          res
            .status(409)
            .json({ error: t('api.file.externalModified'), code: 'FILE_EXTERNAL_MODIFIED' });
          return;
        }
      }

      // 7. Shadow backup
      const shadowDir = path.join(
        process.env.HOME || process.env.USERPROFILE || '/tmp',
        '.doc77',
        'shadow',
        `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      );
      let shadowCreated = false;
      try {
        if (fileExists) {
          fs.mkdirSync(shadowDir, { recursive: true });
          fs.copyFileSync(absPath, path.join(shadowDir, path.basename(filePath)));
          shadowCreated = true;
        }

        // 8. Write
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');

        // 9. Clear shadow
        if (shadowCreated) {
          shadowCreated = false;
          fs.rmSync(shadowDir, { recursive: true, force: true });
        }

        // 10. Audit log
        await auditLog({
          project_id: projectId,
          operation_type: 'edit_file',
          operation_data: { file_path: filePath, size: Buffer.byteLength(content, 'utf-8') },
          source: 'user',
          status: 'executed',
        });

        // 11. Update cache
        const newStats = fs.statSync(absPath);
        try {
          db.prepare(
            `UPDATE filetree_cache SET scanned_at = datetime('now') WHERE project_id = ? AND node_path = ?`,
          ).run(projectId, path.dirname(filePath));
        } catch {}

        res.json({ ok: true, size: newStats.size, modified: newStats.mtime.toISOString() });
      } catch (writeErr: unknown) {
        // Rollback
        const message = writeErr instanceof Error ? writeErr.message : 'Unknown error';
        if (shadowCreated) {
          try {
            const sf = path.join(shadowDir, path.basename(filePath));
            if (fs.existsSync(sf)) fs.copyFileSync(sf, absPath);
            fs.rmSync(shadowDir, { recursive: true, force: true });
          } catch {}
        }
        await auditLog({
          project_id: projectId,
          operation_type: 'edit_file',
          operation_data: { file_path: filePath },
          source: 'user',
          status: 'failed',
          error_message: message,
        });
        res.status(500).json({ error: t('api.file.saveFailed', { message }), code: 'SAVE_FAILED' });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('Path traversal') || message.includes('outside project root')) {
        res.status(403).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // Serve raw binary files (images, PDFs) with proper Content-Type
  app.get('/api/raw/:id', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const filePath = req.query.path as string;

    if (isNaN(projectId) || !filePath) {
      res.status(400).json({ error: 'Invalid request' });
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

      const absPath = validatePath(project.path, filePath);
      const ext = path.extname(filePath).toLowerCase();

      // Map extension to MIME type
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.htm': 'text/html',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.avif': 'image/avif',
        '.pdf': 'application/pdf',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      const buffer = fs.readFileSync(absPath);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  });

  // Reveal file in editor or file manager
  app.get('/api/reveal/:id', (req: Request, res: Response) => {
    const projectId = parseInt(req.params.id, 10);
    const filePath = req.query.path as string;
    const action = (req.query.action as string) || 'reveal';

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
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

      const absPath = validatePath(project.path, filePath);
      const platform = process.platform;
      const isWSL =
        platform === 'linux' &&
        ((): boolean => {
          try {
            return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
          } catch {
            return false;
          }
        })();
      let command: string;

      if (action === 'edit') {
        if (isWSL) {
          // WSL: use 'code' command (installed by VS Code Remote) or cmd.exe for Windows VS Code
          command = `code "${absPath}" 2>/dev/null || cmd.exe /c start "vscode://file/${absPath}" 2>/dev/null || explorer.exe /select,"${absPath.replace(/\//g, '\\')}"`;
        } else if (platform === 'darwin') {
          command = `open "vscode://file/${absPath}" 2>/dev/null || open -R "${absPath}"`;
        } else if (platform === 'win32') {
          command = `start "" "vscode://file/${absPath}" 2>nul || explorer /select,"${absPath}"`;
        } else {
          command = `xdg-open "vscode://file/${absPath}" 2>/dev/null || xdg-open "${path.dirname(absPath)}"`;
        }
      } else {
        // Reveal in file manager
        if (isWSL) {
          command = `explorer.exe /select,"${absPath.replace(/\//g, '\\')}"`;
        } else if (platform === 'darwin') {
          command = `open -R "${absPath}"`;
        } else if (platform === 'win32') {
          command = `explorer /select,"${absPath}"`;
        } else {
          command = `xdg-open "${path.dirname(absPath)}"`;
        }
      }

      exec(command, (error: Error | null) => {
        if (error) {
          console.error('[reveal]', error.message);
        }
      });

      res.json({ ok: true, action, path: absPath });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  });

  // === Queue / Approval API ===

  // Get queue status for a project
  app.get('/api/queue/status', (req: Request, res: Response) => {
    const projectId = req.query.project_id
      ? parseInt(req.query.project_id as string, 10)
      : undefined;

    try {
      // Dynamic import to avoid circular dependency at module load time
      const db = getConnection();
      let rows;
      if (projectId) {
        rows = db
          .prepare(
            `SELECT id, project_id, operation_type, operation_data, status, created_at
           FROM operation_queue WHERE project_id = ? ORDER BY id DESC LIMIT 50`,
          )
          .all(projectId);
      } else {
        rows = db
          .prepare(
            `SELECT id, project_id, operation_type, operation_data, status, created_at
           FROM operation_queue ORDER BY id DESC LIMIT 50`,
          )
          .all();
      }
      res.json(rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Approve a task (handled by CLI layer via createQueueApproveHandler to avoid
  // a cross-package circular import between @doc77/core and @doc77/mcp)

  // Reject a task
  app.post('/api/queue/reject', (req: Request, res: Response) => {
    const { task_id } = req.body;
    if (!task_id) {
      res.status(400).json({ error: 'task_id is required' });
      return;
    }

    try {
      const db = getConnection();
      const task = db
        .prepare('SELECT * FROM operation_queue WHERE id = ? AND status = ?')
        .get(task_id, 'pending') as unknown;

      if (!task) {
        res.status(404).json({ error: 'Task not found or not pending' });
        return;
      }

      db.prepare(
        "UPDATE operation_queue SET status = 'rejected', updated_at = datetime('now') WHERE id = ?",
      ).run(task_id);

      res.json({ task_id, status: 'rejected' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // === AI Test Connection ===

  // (helper for reading & decrypting AI config)
  const { getDecryptedAiConfig } = (() => {
    const fn = (): { token: string; baseUrl: string; model: string } | null => {
      const db = getConnection();
      const tokenRow = db.prepare("SELECT value FROM config WHERE key = 'ai.token'").get() as
        { value: string } | undefined;
      const baseRow = db.prepare("SELECT value FROM config WHERE key = 'ai.base_url'").get() as
        { value: string } | undefined;
      const modelRow = db.prepare("SELECT value FROM config WHERE key = 'ai.model'").get() as
        { value: string } | undefined;

      if (!tokenRow?.value) return null;

      const baseUrl = baseRow?.value || 'https://api.deepseek.com';
      const model = modelRow?.value || 'deepseek-v4-pro';

      let token = tokenRow.value;
      if (token.startsWith('{')) {
        try {
          const encData = JSON.parse(token);
          if (encData.iv && encData.tag && encData.ciphertext) {
            const authRow = db.prepare('SELECT pbkdf2_salt FROM user_auth WHERE id = 1').get() as
              { pbkdf2_salt: string } | undefined;
            if (authRow?.pbkdf2_salt) {
              const encKey = crypto.deriveKey(
                'doc77-config-key',
                Buffer.from(authRow.pbkdf2_salt, 'hex'),
              );
              token = crypto.decrypt(encData, encKey);
            }
          }
        } catch {
          /* not encrypted */
        }
      }

      return { token, baseUrl, model };
    };
    return { getDecryptedAiConfig: fn };
  })();

  app.post('/api/ai/test', async (req: Request, res: Response) => {
    try {
      const cfg = getDecryptedAiConfig();
      if (!cfg) {
        res.json({ ok: false, error: t('api.ai.notConfigured'), code: 'AI_NOT_CONFIGURED' });
        return;
      }
      // Guard: reject non-latin-1 tokens that would crash the HTTP header build
      if (cfg.token && [...cfg.token].some((c) => c.charCodeAt(0) > 255)) {
        res.json({ ok: false, error: t('api.ai.tokenInvalid'), code: 'AI_TOKEN_INVALID' });
        return;
      }
      const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        res.json({ ok: true, status: resp.status });
      } else {
        const errText = await resp.text().catch(() => '');
        let errMsg = `HTTP ${resp.status}`;
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message || errMsg;
        } catch {}
        res.json({ ok: false, error: errMsg });
      }
    } catch (e: unknown) {
      let message = e instanceof Error ? e.message : 'Unknown error';
      // Include the underlying cause (DNS/connection refused/etc.) which Node.js
      // native fetch stores in .cause but the default message loses.
      if (e instanceof Error && (e as any).cause) {
        const cause = (e as any).cause;
        message += ` (${cause.message || cause.code || cause})`;
      }
      res.json({
        ok: false,
        error: t('api.ai.networkError', { message }),
        code: 'AI_NETWORK_ERROR',
      });
    }
  });

  // === Translation (Offline) ===

  app.get('/api/translate/status', async (_req: Request, res: Response) => {
    try {
      const { isEngineAvailable, isModelReady } = await import('../translate/index.js');
      const engine = await isEngineAvailable();
      const enzh = engine ? await isModelReady('en-zh') : false;
      const zhen = engine ? await isModelReady('zh-en') : false;
      res.json({ engineAvailable: engine, models: { 'en-zh': enzh, 'zh-en': zhen } });
    } catch {
      res.json({ engineAvailable: false, models: {} });
    }
  });

  app.post('/api/translate', async (req: Request, res: Response) => {
    const { text, source_lang, target_lang, mode } = req.body || {};
    if (!text || !target_lang) {
      res.status(400).json({ error: 'text and target_lang are required' });
      return;
    }
    try {
      const { isEngineAvailable, translate, segmentText } = await import('../translate/index.js');
      if (!(await isEngineAvailable())) {
        res
          .status(503)
          .json({ error: t('api.translate.notInstalled'), code: 'ENGINE_UNAVAILABLE' });
        return;
      }
      const src = source_lang || 'auto';
      const tgt = target_lang;
      if (mode === 'document' && text.length > 300) {
        const segments = segmentText(text);
        const translations = [];
        const startTime = Date.now();
        for (const seg of segments) {
          translations.push((await translate(seg.text, src, tgt)).translated_text);
        }
        return res.json({
          translated_text: translations.join('\n\n'),
          source_lang: src,
          target_lang: tgt,
          segment_count: segments.length,
          duration_ms: Date.now() - startTime,
          model: 'Opus-MT (ONNX)',
        });
      }
      const result = await translate(text, src, tgt);
      res.json({
        translated_text: result.translated_text,
        source_lang: result.source_lang,
        target_lang: result.target_lang,
        duration_ms: result.duration_ms,
        model: 'Opus-MT (ONNX)',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg === 'ENGINE_UNAVAILABLE') {
        res
          .status(503)
          .json({ error: t('api.translate.engineUnavailable'), code: 'ENGINE_UNAVAILABLE' });
      } else if (
        msg === 'MODEL_NOT_READY' ||
        msg.includes('fetch failed') ||
        msg.includes('Network Error') ||
        msg.includes('ENOENT') ||
        msg.includes('Could not locate file')
      ) {
        res.status(503).json({ error: t('api.translate.modelNotReady'), code: 'MODEL_NOT_READY' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // === AI Session Reset ===

  app.post('/api/ai/reset', (req: Request, res: Response) => {
    const { session_id } = req.body;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    const ok = resetSession(session_id);
    res.json({ ok });
  });

  // === AI Chat API (handled by CLI layer via createAIChatHandler to avoid
  //     a circular dependency between @doc77/core and @doc77/ai) ===

  // === Search API ===

  /**
   * Recursively search text files under `dirPath` for `keyword`.
   * Pure Node.js — no external dependencies (grep, ripgrep, etc.).
   * Cross-platform: works on Windows, macOS, and Linux.
   */
  function searchInFiles(
    dirPath: string,
    keyword: string,
    maxResults = 50,
  ): Array<{ file: string; line: number; content: string }> {
    const results: Array<{ file: string; line: number; content: string }> = [];
    const lowerKey = keyword.toLowerCase();
    const SKIP_DIRS = new Set([
      'node_modules',
      '.git',
      '.svn',
      '__pycache__',
      '.venv',
      'venv',
      'dist',
      '.cache',
      '.next',
      '.nuxt',
      'build',
      'target',
    ]);
    const SKIP_EXT = new Set([
      '.exe',
      '.dll',
      '.so',
      '.dylib',
      '.bin',
      '.class',
      '.jar',
      '.war',
      '.o',
      '.wasm',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.svg',
      '.webp',
      '.ico',
      '.bmp',
      '.avif',
      '.mp4',
      '.mp3',
      '.wav',
      '.ogg',
      '.flac',
      '.aac',
      '.mov',
      '.avi',
      '.mkv',
      '.zip',
      '.tar',
      '.gz',
      '.7z',
      '.rar',
      '.bz2',
      '.xz',
      '.zst',
      '.pdf',
      '.docx',
      '.xlsx',
      '.pptx',
      '.epub',
      '.mobi',
      '.ttf',
      '.woff',
      '.woff2',
      '.otf',
      '.eot',
      '.db',
      '.sqlite',
      '.sqlite3',
    ]);

    function walk(dir: string) {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith('.')) continue; // skip dotfiles/dotdirs

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SKIP_EXT.has(ext)) continue;
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              if (lines[i].toLowerCase().includes(lowerKey)) {
                results.push({
                  file: fullPath.slice(dirPath.length + 1), // relative path
                  line: i + 1,
                  content: lines[i].substring(0, 200),
                });
              }
            }
          } catch {
            /* skip unreadable / binary files */
          }
        }
      }
    }

    walk(dirPath);
    return results;
  }

  // Full-text search (cross-platform, pure Node.js — no grep dependency)
  app.get('/api/search', (req: Request, res: Response) => {
    const keyword = (req.query.q as string) || '';
    const projectId = parseInt(req.query.project_id as string, 10);

    if (!keyword || keyword.length < 2) {
      res.status(400).json({ error: 'keyword must be at least 2 characters' });
      return;
    }
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'project_id is required' });
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

      const matches = searchInFiles(project.path, keyword, 50);
      res.json({ keyword, matches });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // === Auth API ===

  // Check auth status
  app.get('/api/auth/status', (_req: Request, res: Response) => {
    try {
      const db = getConnection();
      const row = db
        .prepare('SELECT password_hash, wrapped_dek_by_password FROM user_auth WHERE id = 1')
        .get() as { password_hash: string; wrapped_dek_by_password: string } | undefined;
      const recoveryStatus = auth.getRecoveryStatus();
      res.json({
        hasPassword: !!row?.password_hash,
        hasRecovery: recoveryStatus.hasRecovery,
        isLegacy: !!(row?.password_hash && !row?.wrapped_dek_by_password),
      });
    } catch {
      res.json({ hasPassword: false, hasRecovery: false, isLegacy: false });
    }
  });

  // Setup password (first time, or legacy migration)
  app.post('/api/auth/setup', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password || password.length < 6) {
      res.status(400).json({ error: t('api.auth.passwordTooShort'), code: 'PASSWORD_TOO_SHORT' });
      return;
    }
    try {
      // Allow overwrite if legacy mode (old hash, no DEK)
      const codes = auth.isLegacyMode()
        ? auth.setupPasswordLegacy(password)
        : auth.setupPasswordWithDEK(password);
      if (!codes) {
        res
          .status(409)
          .json({ error: t('api.auth.passwordAlreadySet'), code: 'PASSWORD_ALREADY_SET' });
        return;
      }
      res.json({ ok: true, recovery_codes: codes.formatted });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Login
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password) {
      res.status(400).json({ error: t('api.auth.passwordRequired'), code: 'PASSWORD_REQUIRED' });
      return;
    }
    try {
      const result = auth.verifyLogin(password);
      if (result.ok) {
        res.json({ ok: true, token: result.token });
      } else {
        res.status(result.status).json({
          ok: false,
          error: result.error,
          ...(result.legacyMigration ? { legacyMigration: true } : {}),
        });
      }
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Forgot password — verify recovery code
  app.post('/api/auth/forgot-password/verify', (req: Request, res: Response) => {
    const { recovery_code } = req.body;
    if (!recovery_code || typeof recovery_code !== 'string') {
      res.status(400).json({ error: 'invalid_recovery_code_format' });
      return;
    }
    try {
      const result = auth.verifyRecoveryCode(recovery_code);
      if (result.ok) {
        res.json({
          ok: true,
          reset_token: result.resetToken,
          remaining_codes: result.remaining,
        });
      } else {
        res.status(result.status).json({ error: result.error });
      }
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Forgot password — reset with token
  app.post('/api/auth/forgot-password/reset', (req: Request, res: Response) => {
    const { reset_token, new_password } = req.body;
    if (!reset_token || !new_password) {
      res.status(400).json({ error: 'reset_token and new_password are required' });
      return;
    }
    if (new_password.length < 6) {
      res.status(400).json({ error: t('api.auth.passwordTooShort'), code: 'PASSWORD_TOO_SHORT' });
      return;
    }
    try {
      const result = auth.resetPasswordWithToken(reset_token, new_password);
      if (result.ok) {
        res.json({ ok: true });
      } else {
        res.status(result.status).json({ error: result.error });
      }
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Change password (requires current password)
  app.post('/api/auth/change-password', (req: Request, res: Response) => {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) {
      res.status(400).json({ error: 'old_password and new_password are required' });
      return;
    }
    if (new_password.length < 6) {
      res.status(400).json({ error: t('api.auth.passwordTooShort'), code: 'PASSWORD_TOO_SHORT' });
      return;
    }
    try {
      const result = auth.changePassword(old_password, new_password);
      if (result.ok) {
        const resp: Record<string, unknown> = { ok: true };
        if (result.codes) resp.recovery_codes = result.codes.formatted;
        res.json(resp);
      } else {
        res.status(result.status).json({ error: result.error });
      }
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Get recovery code status
  // TODO(I5): Add auth middleware — minor info leak without auth,
  //           auth middleware is known tech debt per spec Section 11
  app.get('/api/auth/recovery-status', (_req: Request, res: Response) => {
    try {
      const status = auth.getRecoveryStatus();
      res.json(status);
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Regenerate recovery codes (POST with JSON body)
  app.post('/api/auth/recovery-codes', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password) {
      res.status(400).json({ error: 'password is required' });
      return;
    }
    try {
      const result = auth.regenerateRecoveryCodes(password);
      if (result.ok) {
        res.json({ ok: true, recovery_codes: result.codes!.formatted });
      } else {
        res.status(result.status).json({ error: result.error });
      }
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Force-reset password — wipe all auth state (requires confirmation)
  // Force-reset password — requires current password verification (defense-in-depth)
  // No auth middleware exists yet (tech debt per spec Section 11), so we
  // gate on knowledge of the current password, matching nearby endpoints.
  app.post('/api/auth/force-reset', (req: Request, res: Response) => {
    const { password, confirm } = req.body;
    if (confirm !== 'yes-i-know') {
      res.status(400).json({ error: t('api.auth.confirmRequired'), code: 'CONFIRM_REQUIRED' });
      return;
    }
    try {
      // Require current password verification if one is set
      const db = getConnection();
      const authRow = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as
        { password_hash: string } | undefined;
      if (authRow?.password_hash) {
        if (!password) {
          res.status(400).json({
            error: t('api.auth.passwordRequiredForReset'),
            code: 'PASSWORD_REQUIRED_FOR_RESET',
          });
          return;
        }
        if (!crypto.verifyPassword(password, authRow.password_hash)) {
          // Also try legacy params before rejecting
          if (!crypto.verifyPasswordLegacy(password, authRow.password_hash)) {
            res
              .status(401)
              .json({ error: t('api.auth.incorrectPassword'), code: 'INCORRECT_PASSWORD' });
            return;
          }
        }
      }
      auth.forceResetPassword();
      res.json({ ok: true, message: t('api.auth.securityCleared') });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // === Config API ===

  app.get('/api/config', (_req: Request, res: Response) => {
    try {
      const db = getConnection();
      const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all() as {
        key: string;
        value: string;
      }[];
      const result: Record<string, string> = {};
      for (const r of rows) {
        result[r.key] = crypto.isSensitiveKey(r.key) ? crypto.maskSensitive(r.value) : r.value;
      }
      res.json(result);
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.put('/api/config', (req: Request, res: Response) => {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      res.status(400).json({ error: 'key and value required' });
      return;
    }
    try {
      const db = getConnection();

      // Guard: reject masked sensitive values (e.g. "sk-1••••cdef") to
      // prevent corruption from the load→save round-trip on the client side.
      if (typeof value === 'string' && value.includes('•') && crypto.isSensitiveKey(key)) {
        res.json({ ok: true, key, skipped: true });
        return;
      }

      // Guard: reject empty bind_address — 空字符串重启时被判 falsy 导致 --bind 被丢弃
      if (key === 'security.bind_address' && typeof value === 'string' && value.trim() === '') {
        res.json({ ok: true, key, skipped: true });
        return;
      }

      let storeValue = value;
      // Encrypt sensitive fields
      if (crypto.isSensitiveKey(key)) {
        const authRow = db.prepare('SELECT pbkdf2_salt FROM user_auth WHERE id = 1').get() as
          { pbkdf2_salt: string } | undefined;
        if (authRow?.pbkdf2_salt) {
          // Use a fixed passphrase for config encryption (derived from user password if available)
          // For now, store encrypted with a local key
          const encKey = crypto.deriveKey(
            'doc77-config-key',
            Buffer.from(authRow.pbkdf2_salt, 'hex'),
          );
          const enc = crypto.encrypt(value, encKey);
          storeValue = JSON.stringify(enc);
        }
      }
      db.prepare(
        'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, storeValue);
      // Language change takes effect immediately for backend t() (API errors,
      // AI runtime). MCP tool descriptions are registered at startup and still
      // need a restart — the settings panel toast already says so.
      if (key === 'locale.language') {
        initI18n(String(value || ''));
      }
      res.json({ ok: true, key });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // --- Error handler ---
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[server error]', err.message);
    res.status(500).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    });
  });

  // Cleanup on app close — share manager + mDNS publisher
  app.on('close', () => {
    shareManager.destroy();
    mdnsService?.destroy();
  });

  return app;
}

/**
 * Map a file extension to a human-readable category label for the unsupported-format UI.
 */
function getFileCategory(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video',
    '.avi': 'video',
    '.mov': 'video',
    '.mkv': 'video',
    '.webm': 'video',
    '.wmv': 'video',
    '.flv': 'video',
    '.m4v': 'video',
    '.mp3': 'audio',
    '.wav': 'audio',
    '.ogg': 'audio',
    '.flac': 'audio',
    '.aac': 'audio',
    '.wma': 'audio',
    '.m4a': 'audio',
    '.opus': 'audio',
    '.zip': 'archive',
    '.tar': 'archive',
    '.gz': 'archive',
    '.7z': 'archive',
    '.rar': 'archive',
    '.bz2': 'archive',
    '.xz': 'archive',
    '.zst': 'archive',
    '.ttf': 'font',
    '.woff': 'font',
    '.woff2': 'font',
    '.otf': 'font',
    '.eot': 'font',
    '.db': 'database',
    '.sqlite': 'database',
    '.sqlite3': 'database',
    '.mdb': 'database',
    '.accdb': 'database',
    '.psd': 'design',
    '.ai': 'design',
    '.sketch': 'design',
    '.fig': 'design',
    '.xd': 'design',
    '.exe': 'binary',
    '.dll': 'binary',
    '.so': 'binary',
    '.dylib': 'binary',
    '.bin': 'binary',
    '.class': 'binary',
    '.jar': 'binary',
    '.war': 'binary',
    '.o': 'binary',
    '.wasm': 'binary',
    '.shp': 'gis',
    '.shx': 'gis',
    '.dbf': 'gis',
    '.obj': '3d',
    '.stl': '3d',
    '.glb': '3d',
    '.gltf': '3d',
    '.epub': 'ebook',
    '.mobi': 'ebook',
    '.pages': 'document',
    '.numbers': 'spreadsheet',
    '.key': 'presentation',
    '.ppt': 'presentation',
    '.pptx': 'presentation',
  };
  return map[ext] || 'unknown';
}

/**
 * Look up a project by its numeric ID.
 */
function getProjectById(id: number | string) {
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
  if (isNaN(numericId)) return undefined;
  const projects = listProjects();
  return projects.find((p: { id: number }) => p.id === numericId);
}

/**
 * Create a POST /api/queue/approve handler.
 *
 * Accepts the executor function as a dependency to avoid a circular
 * cross-package import between @doc77/core and @doc77/mcp.
 *
 * Usage (in CLI layer):
 *   app.post('/api/queue/approve', createQueueApproveHandler(executeApprovedTasks));
 */
export function createQueueApproveHandler(
  executeApprovedTasks: (
    projectId: number,
    taskIds: string[],
  ) => Promise<{ success: boolean; errors: string[] }>,
) {
  return async (req: Request, res: Response) => {
    const { task_id } = req.body;
    if (!task_id) {
      res.status(400).json({ error: 'task_id is required' });
      return;
    }

    try {
      const db = getConnection();
      const task = db
        .prepare('SELECT * FROM operation_queue WHERE id = ? AND status = ?')
        .get(task_id, 'pending') as
        { id: number; project_id: number; operation_type: string; status: string } | undefined;

      if (!task) {
        res.status(404).json({ error: 'Task not found or not pending' });
        return;
      }

      db.prepare(
        "UPDATE operation_queue SET status = 'approved', updated_at = datetime('now') WHERE id = ?",
      ).run(task_id);

      // Fire-and-forget execution
      executeApprovedTasks(task.project_id, [String(task.id)]).catch((e: Error) =>
        console.error('[executor]', e.message),
      );

      res.json({ task_id, status: 'approved' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  };
}

/**
 * Create POST /api/ai/chat handler with SSE streaming + tool-use.
 *
 * Accepts AI dependencies as parameters to avoid a circular dependency
 * between @doc77/core and @doc77/ai. Register from the CLI layer.
 *
 * Usage (in CLI start command):
 *   const { AiProvider, DocAgent, getReadTools, getWriteTools } = await import('@doc77/ai');
 *   app.post('/api/ai/chat', createAIChatHandler({ AiProvider, DocAgent, getReadTools, getWriteTools }));
 */
export function createAIChatHandler(deps: {
  AiProvider: new (config: { apiKey: string; baseUrl: string; model: string }) => SessionAgent;
  DocAgent: new (config: {
    provider: SessionAgent;
    model: string;
    tools: unknown[];
    executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
    maxSteps: number;
  }) => SessionAgent & {
    hasContext: boolean;
    addContext(ctx: string): void;
    chatStream(
      message: string,
      opts?: { noTools?: boolean },
    ): AsyncIterable<
      | { type: 'token'; content: string }
      | { type: 'tool_call_start'; name: string }
      | { type: 'tool_call'; name: string; arguments: string; status: string }
      | { type: 'done' }
      | { type: 'error'; message: string }
    >;
  };
  getReadTools: () => unknown[];
  // Optional write integration — injected by the CLI layer only when @doc77/mcp
  // is installed. When absent, the AI agent stays read-only.
  getWriteTools?: () => unknown[];
  writeFns?: AiWriteFns;
}) {
  const { AiProvider, DocAgent, getReadTools } = deps;
  // One limiter for the lifetime of the handler (persists across requests).
  const aiRateLimiter = createRateLimiter();

  return async (req: Request, res: Response) => {
    const { message, project_id, session_id, context_file } = req.body;
    console.error(
      `[ai] chat request: session=${session_id || 'new'}, project=${project_id}, context_file=${context_file || 'none'}, msg="${(message || '').slice(0, 100)}"`,
    );
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const { getDecryptedAiConfig } = (() => {
      type AiConfig = { token: string; baseUrl: string; model: string } | null;
      const fn = (): AiConfig => {
        const db = getConnection();
        const tokenRow = db.prepare("SELECT value FROM config WHERE key = 'ai.token'").get() as
          { value: string } | undefined;
        const baseRow = db.prepare("SELECT value FROM config WHERE key = 'ai.base_url'").get() as
          { value: string } | undefined;
        const modelRow = db.prepare("SELECT value FROM config WHERE key = 'ai.model'").get() as
          { value: string } | undefined;
        if (!tokenRow?.value) return null;
        const baseUrl = baseRow?.value || 'https://api.deepseek.com';
        const model = modelRow?.value || 'deepseek-v4-pro';
        let token = tokenRow.value;
        if (token.startsWith('{')) {
          try {
            const encData = JSON.parse(token);
            if (encData.iv && encData.tag && encData.ciphertext) {
              const authRow = db.prepare('SELECT pbkdf2_salt FROM user_auth WHERE id = 1').get() as
                { pbkdf2_salt: string } | undefined;
              if (authRow?.pbkdf2_salt) {
                const encKey = crypto.deriveKey(
                  'doc77-config-key',
                  Buffer.from(authRow.pbkdf2_salt, 'hex'),
                );
                token = crypto.decrypt(encData, encKey);
              }
            }
          } catch {
            /* not encrypted */
          }
        }
        return { token, baseUrl, model };
      };
      return { getDecryptedAiConfig: fn };
    })();

    const cfg = getDecryptedAiConfig();
    if (!cfg) {
      res.status(400).json({ error: t('api.ai.notConfiguredMessage'), code: 'AI_NOT_CONFIGURED' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Reads a project-relative file for AI consumption: enforces sensitive-file
      // blocking, path sandboxing, and 4000-char truncation. Returns the content
      // or an "Error: ..." string (never throws) so the read_file tool and the
      // context_file fast-path share identical semantics.
      const readProjectFileContent = (pid: number, filePath: string): string => {
        if (!filePath) return 'Error: file_path is required';
        const fileName = filePath.split('/').pop() || filePath;
        if (isSensitiveFile(fileName))
          return `Error: Access denied — "${fileName}" is a sensitive file`;
        try {
          const db = getConnection();
          const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as
            { path: string } | undefined;
          if (!project) return 'Error: Project not found';
          const absPath = validatePath(project.path, filePath);
          const content = readFile(absPath);
          return content.length > 4000
            ? content.slice(0, 4000) + `\n\n[... truncated, total ${content.length} chars]`
            : content;
        } catch (e: unknown) {
          return `Error: ${e instanceof Error ? e.message : 'Unknown'}`;
        }
      };

      // Session id is assigned after getOrCreateSession below; write tools read
      // it via this closure variable (they only run during chatStream, later).
      let toolSessionId = '';

      const getRiskLevel = (): string => {
        try {
          const row = getConnection()
            .prepare("SELECT value FROM config WHERE key = 'ai.risk_level'")
            .get() as { value: string } | undefined;
          return row?.value || 'medium';
        } catch {
          return 'medium';
        }
      };

      const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const pid = (args.project_id as number) || project_id;
        console.error(`[ai] executeTool: "${name}" pid=${pid}`, args);
        if (!pid) return 'Error: project_id is required';
        // Write tools enqueue into the approval queue; they never execute here.
        if (isAiWriteTool(name)) {
          if (!deps.writeFns) return t('ai.context.writeToolsUnavailable');
          return executeAiWriteTool(
            name,
            args,
            { projectId: pid, sessionId: toolSessionId },
            { writeFns: deps.writeFns, isSensitiveFile, getRiskLevel },
          );
        }
        switch (name) {
          case 'list_files': {
            const dirPath = (args.dir_path as string) || '';
            const result = scanDirectory(pid, dirPath);
            const entries = result.entries.slice(0, 50);
            if (entries.length === 0) return t('ai.context.dirEmpty', { dirPath: dirPath || '/' });
            const output = entries
              .map(
                (e) =>
                  `${e.type === 'directory' ? '📁' : '📄'} ${e.name} (${e.type}, ${e.size ?? 'N/A'} bytes)`,
              )
              .join('\n');
            console.error(`[ai] executeTool: list_files "${dirPath}" → ${entries.length} entries`);
            return output;
          }
          case 'read_file':
            return readProjectFileContent(pid, args.file_path as string);
          case 'get_file_info': {
            const filePath = args.file_path as string;
            if (!filePath) return 'Error: file_path is required';
            try {
              const db = getConnection();
              const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as
                { path: string } | undefined;
              if (!project) return 'Error: Project not found';
              const absPath = validatePath(project.path, filePath);
              const stats = fs.statSync(absPath);
              return `File: ${filePath}\nType: ${stats.isDirectory() ? 'directory' : 'file'}\nSize: ${stats.size} bytes\nModified: ${stats.mtime.toISOString()}`;
            } catch (e: unknown) {
              return `Error: ${e instanceof Error ? e.message : 'Unknown'}`;
            }
          }
          case 'list_projects': {
            const { listProjects } = await import('@doc77/mcp');
            const projects = listProjects();
            return JSON.stringify(projects);
          }
          case 'search_files': {
            const { searchFiles } = await import('@doc77/mcp');
            const results = searchFiles(pid, args.query as string, {
              searchPath: args.path as string | undefined,
              glob: args.glob as string | undefined,
            });
            return JSON.stringify(results);
          }
          default:
            return `Error: Unknown tool "${name}"`;
        }
      };

      const provider = new AiProvider({
        apiKey: cfg.token,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
      });
      const {
        sessionId: sid,
        agent,
        isNew,
      } = getOrCreateSession(
        session_id,
        () =>
          new DocAgent({
            provider,
            model: cfg.model,
            // Expose write tools only when MCP write functions were injected.
            tools: (() => {
              const readTools = getReadTools();
              const writeFnsAvailable = !!deps.writeFns;
              const writeTools = writeFnsAvailable ? deps.getWriteTools?.() || [] : [];
              console.error(
                `[ai] build tools: read=${readTools.length}, write=${writeTools.length}, writeFns=${writeFnsAvailable}, total=${readTools.length + writeTools.length}`,
              );
              console.error(
                `[ai] tool names: ${[...readTools, ...writeTools].map((t: any) => t?.function?.name || t?.name || '?').join(', ')}`,
              );
              return [...readTools, ...writeTools] as any[];
            })(),
            executeTool,
            maxSteps: 5,
          }) as any,
        project_id,
      );
      toolSessionId = sid;
      // Track last context_file per session for dynamic context strategy:
      // first reference → inject content + noTools; same file again → path hint + tools enabled.
      const sessionLastFile = new Map<string, string>();
      // Rehydrate a persisted conversation when the client reconnects to a
      // session that isn't in the in-memory cache (e.g. after a server restart).
      if (isNew && session_id) {
        try {
          const stored = loadAiSession(session_id);
          if (stored && stored.messages.length) (agent as any).setHistory(stored.messages);
        } catch {
          /* corrupt record — start fresh */
        }
      }

      // Per-session rate limit (message ceiling over a 5-minute window).
      const rlLimit = (() => {
        try {
          const row = getConnection()
            .prepare("SELECT value FROM config WHERE key = 'ai.read_limit_per_session'")
            .get() as { value: string } | undefined;
          return parseInt(row?.value || '200', 10) || 200;
        } catch {
          return 200;
        }
      })();
      if (!aiRateLimiter.check(sid, rlLimit, 5 * 60 * 1000, Date.now()).allowed) {
        send('error', { message: t('ai.context.rateLimited') });
        res.end();
        return;
      }

      // Skip project-level context when user has a specific file open
      // (context_file injects the file content instead; the project listing
      // would bias the answer toward the whole system, not that document).
      if (project_id && !(agent as any).hasContext && !context_file) {
        try {
          const root = scanDirectory(project_id, '');
          const fileList = root.entries
            .slice(0, 30)
            .map((e) => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}`)
            .join('\n');
          const proj = (() => {
            const db = getConnection();
            return db.prepare('SELECT name, path FROM projects WHERE id = ?').get(project_id) as
              { name: string; path: string } | undefined;
          })();
          const fileListDisplay = fileList || t('ai.context.emptyDir');
          (agent as any).addContext(
            t('ai.context.projectInfo', {
              name: proj?.name || 'Unknown',
              path: proj?.path || 'N/A',
              fileList: fileListDisplay,
            }),
          );
        } catch {
          /* non-fatal */
        }
      }

      send('session', { session_id: sid });

      // Fast-path for "summarize the file I have open": the frontend passes the
      // opened file's path as context_file. We read its content directly and
      // embed it into the prompt, then disable tools for this turn — otherwise
      // the agent, seeing only a path, would burn tokens crawling directories
      // (list_files) and re-reading files to rediscover what's already open.
      let outgoing = message;
      let noTools = false;
      if (context_file && project_id) {
        const lastFile = sessionLastFile.get(sid);
        const content = readProjectFileContent(project_id, context_file as string);
        if (!content.startsWith('Error:')) {
          if (context_file !== lastFile) {
            // First reference (or switched to a new file): inject content + disable tools for fast answer
            console.error(
              `[ai] context_file: first ref to "${context_file}" — inject content + noTools`,
            );
            outgoing = `${message}\n\n---\n${t('ai.context.fileDirective', { file: context_file as string })}\n\n${content}`;
            noTools = true;
          } else {
            // Same file again: inject path hint only + keep tools enabled so the agent can
            // use read_file / search_files to actively explore the file
            console.error(
              `[ai] context_file: same file "${context_file}" — path hint only, tools ON`,
            );
            outgoing = `${message}\n\n---\n${t('ai.context.currentFileHint', { file: context_file as string })}`;
            // noTools stays false
          }
          sessionLastFile.set(sid, context_file as string);
        }
      }

      for await (const chunk of (agent as any).chatStream(outgoing, { noTools })) {
        switch (chunk.type) {
          case 'token':
            send('token', { text: chunk.content });
            break;
          case 'tool_call_start':
            // Real-time indicator the moment the tool name is known.
            send('tool_call', { name: chunk.name, arguments: '', status: 'executing' });
            break;
          case 'tool_call':
            send('tool_call', {
              name: chunk.name,
              arguments: chunk.arguments,
              status: 'executing',
            });
            break;
          case 'done':
            send('done', {});
            break;
          case 'error':
            send('error', { message: chunk.message });
            break;
        }
      }

      // Persist the updated conversation so it survives a server restart.
      try {
        saveAiSession(sid, project_id, (agent as any).getHistory());
      } catch {
        /* non-fatal */
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      send('error', { message: t('ai.context.serviceError', { msg }) });
    }

    res.end();
  };
}
