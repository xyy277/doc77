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
import { isMobileRequest } from './mobile-detect.js';

import { VERSION } from '../version.gen.js';

// Module capabilities — set by CLI layer at startup
let _capabilities = { ai: false, mcp: false };
export function setCapabilities(caps: { ai: boolean; mcp: boolean }) {
  _capabilities = caps;
}

/**
 * Create and configure the Express application.
 * @param restartCallback — if provided, enables POST /api/restart endpoint
 * @param bindAddr — actual runtime bind address (for /api/server-info)
 */
export function createApp(restartCallback?: () => void, bindAddr?: string) {
  const app = express();

  // --- Middleware ---

  // Parse JSON bodies
  app.use(express.json());

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
      res.sendFile(target);
      return;
    }
    // Graceful degradation: fall back to desktop if mobile HTML missing
    if (useMobile) {
      const desktopFallback = path.join(webDir, 'index.html');
      if (fs.existsSync(desktopFallback)) {
        res.sendFile(desktopFallback);
        return;
      }
    }
    res.type('html').send(fallbackHtml);
  });

  app.get('/preview.html', (_req: Request, res: Response) => {
    if (!webDir) {
      res.status(404).type('html').send('<h1>Not Found</h1>');
      return;
    }
    const useMobile = isMobileRequest(_req);
    const target = path.join(webDir, useMobile ? 'mobile/preview.html' : 'preview.html');
    if (fs.existsSync(target)) {
      res.sendFile(target);
      return;
    }
    if (useMobile) {
      const desktopFallback = path.join(webDir, 'preview.html');
      if (fs.existsSync(desktopFallback)) {
        res.sendFile(desktopFallback);
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

  // Serve vendor cache (offline CDN resources)
  const vendorDir = path.join(process.env.HOME || '/home', '.doc77', 'vendor');
  app.use('/vendor', express.static(vendorDir, { fallthrough: true }));

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

  // --- API Routes ---

  // Server info — runtime state (actual bind address, not config)
  app.get('/api/server-info', (_req: Request, res: Response) => {
    const addr = bindAddr || '127.0.0.1';
    const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === 'localhost';
    res.json({
      bindAddress: addr,
      isLocal,
      port: 2777,
      version: VERSION,
    });
  });

  // Module capabilities
  app.get('/api/capabilities', (_req: Request, res: Response) => {
    res.json(_capabilities);
  });

  // Electron: one-click install for AI/MCP modules
  if (process.env.DOC77_ELECTRON) {
    app.post('/api/electron/install', async (req: Request, res: Response) => {
      const mod = (req.body.module as string) || '';
      if (!['ai', 'mcp'].includes(mod)) {
        res.status(400).json({ error: 'invalid module' });
        return;
      }
      try {
        const info = JSON.parse(
          execSync(`curl -s https://registry.npmjs.org/@doc77/${mod}/latest`, {
            encoding: 'utf-8',
          }),
        );
        const dest = path.join(process.env.HOME || '/tmp', '.doc77', 'electron-modules');
        fs.mkdirSync(dest, { recursive: true });
        execSync(`curl -sL "${info.dist.tarball}" -o "${dest}/${mod}.tgz"`);
        execSync(`tar -xzf "${dest}/${mod}.tgz" -C "${dest}"`);
        const src = path.join(dest, 'package');
        const target = path.join(dest, 'node_modules', '@doc77', mod);
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(src, target);
        fs.unlinkSync(path.join(dest, `${mod}.tgz`));
        res.json({ ok: true, message: `@doc77/${mod}@${info.version} 安装完成，重启生效` });
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
        .prepare("SELECT COALESCE(MAX(strftime('%s',last_opened)), MAX(strftime('%s',created_at))) as last_active FROM projects")
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
      db.prepare(
        'DELETE FROM recent_files WHERE project_id = ? AND file_path = ?',
      ).run(projectId, filePath);
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
  app.get('/api/discover', (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || '~';
    const depth = parseInt(req.query.depth as string, 10) || 2;

    // Security: reject blocked roots
    const blocked = ['/etc', '/sys', '/proc', '/dev', '/boot', '/run',
                     '/bin', '/sbin', '/usr', '/var',
                     'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
    const expanded = dirPath.startsWith('~') ? os.homedir() + dirPath.slice(1) : dirPath;
    const resolved = path.resolve(expanded).replace(/\\/g, '/');
    for (const b of blocked) {
      const bn = b.replace(/\\/g, '/');
      if (resolved === bn || resolved.startsWith(bn + '/')) {
        res.status(400).json({ error: '此目录不允许扫描' });
        return;
      }
    }

    try {
      // Collect already-registered paths for dedup
      const db = getConnection();
      const registered = db.prepare('SELECT path FROM projects').all() as { path: string }[];
      const existingPaths = new Set(registered.map(r => path.resolve(r.path)));

      const results = discoverProjects(dirPath, Math.min(depth, 5), existingPaths);
      res.json(results);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Project CRUD
  app.get('/api/projects', (_req: Request, res: Response) => {
    const db = getConnection();
    const projects = db
      .prepare(
        `SELECT p.id, p.name, p.path, p.created_at, p.last_opened,
              CASE WHEN f.project_id IS NOT NULL THEN 1 ELSE 0 END as favorited
       FROM projects p
       LEFT JOIN favorites f ON f.project_id = p.id
       ORDER BY p.name`,
      )
      .all();
    res.json(projects);
  });

  app.post('/api/projects', (req: Request, res: Response) => {
    const { name, path: projectPath } = req.body;
    if (!name || !projectPath) {
      res.status(400).json({ error: 'name and path are required' });
      return;
    }
    try {
      const resolved = resolveProjectPath(projectPath);
      const project = registerProject(name, resolved);
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
    const { name, path: newPath } = req.body;
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    if (!name && !newPath) {
      res.status(400).json({ error: 'name or path required' });
      return;
    }
    try {
      const resolved = newPath ? resolveProjectPath(newPath) : undefined;
      updateProject(id, { name, path: resolved });
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
  app.get('/api/browse-fs', (req: Request, res: Response) => {
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
        error: '远程访问模式下不允许浏览 /mnt（Windows 驱动器）',
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
      res.json({ path: dirPath, parent: null, roots: [], entries: [], error: '此目录不允许访问' });
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
  app.post('/api/dialog/open-directory', async (_req: Request, res: Response) => {
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
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
        { path: string } | undefined;

      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

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
              ? `⚠️ 文件过大（${(totalBytes / 1024 / 1024).toFixed(1)} MB），仅显示前 10,000 行。建议在本地编辑器中打开。\n\n---\n\n${content}`
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
            content: renderMarkdown(raw),
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
      let command: string;

      if (action === 'edit') {
        // Try VS Code protocol first, fall back to system open
        const vscodeUrl = `vscode://file/${absPath}`;
        if (platform === 'darwin') {
          command = `open "${vscodeUrl}" 2>/dev/null || open -R "${absPath}"`;
        } else if (platform === 'win32') {
          command = `start "" "${vscodeUrl}" 2>nul || explorer /select,"${absPath}"`;
        } else {
          command = `xdg-open "${vscodeUrl}" 2>/dev/null || xdg-open "${path.dirname(absPath)}"`;
        }
      } else {
        // Reveal in file manager
        if (platform === 'darwin') {
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

      const baseUrl = baseRow?.value || 'https://api.openai.com/v1';
      const model = modelRow?.value || 'gpt-4o';

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
        res.json({ ok: false, error: '请先配置 Base URL 和 API Token' });
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
      const message = e instanceof Error ? e.message : 'Unknown error';
      res.json({ ok: false, error: `网络错误: ${message}` });
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

  // === AI Quick Capabilities ===

  app.post('/api/ai/summarize', async (req: Request, res: Response) => {
    const { project_id, file_path } = req.body;
    if (!project_id || !file_path) {
      res.status(400).json({ error: 'project_id and file_path are required' });
      return;
    }
    try {
      const db = getConnection();
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(project_id) as
        { path: string } | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const absPath = validatePath(project.path, file_path);
      const content = readFile(absPath);
      const summary = `文档摘要（${file_path}）：\n该文档包含 ${content.split('\n').length} 行内容，共 ${content.length} 个字符。主要涉及技术规范和设计文档。`;
      res.json({ summary });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
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
      const row = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as
        { password_hash: string } | undefined;
      res.json({ hasPassword: !!row?.password_hash });
    } catch {
      res.json({ hasPassword: false });
    }
  });

  // Setup password (first time)
  app.post('/api/auth/setup', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password || password.length < 6) {
      res.status(400).json({ error: '密码至少6位' });
      return;
    }
    try {
      const db = getConnection();
      const existing = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as
        { password_hash: string } | undefined;
      if (existing?.password_hash) {
        res.status(409).json({ error: '密码已设置，请使用修改密码功能' });
        return;
      }
      const hash = crypto.hashPassword(password);
      const encSalt = crypto.generateSalt().toString('hex');
      const pbkdf2Salt = crypto.generateSalt().toString('hex');
      db.prepare(
        'INSERT OR REPLACE INTO user_auth (id, password_hash, encryption_salt, pbkdf2_salt) VALUES (1, ?, ?, ?)',
      ).run(hash, encSalt, pbkdf2Salt);
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Login
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password) {
      res.status(400).json({ error: '密码不能为空' });
      return;
    }
    try {
      const db = getConnection();
      const row = db.prepare('SELECT * FROM user_auth WHERE id = 1').get() as
        Record<string, unknown> | undefined;
      if (!row?.password_hash) {
        res.status(404).json({ error: '未设置密码' });
        return;
      }
      if (row.locked_until && new Date(row.locked_until as string) > new Date()) {
        res.status(423).json({ error: '账户已锁定，请稍后再试' });
        return;
      }
      if (!crypto.verifyPassword(password, row.password_hash as string)) {
        const fails = ((row.failed_attempts as number) || 0) + 1;
        if (fails >= 5) {
          db.prepare(
            "UPDATE user_auth SET failed_attempts=0, locked_until=datetime('now','+15 minutes') WHERE id=1",
          ).run();
          res.status(423).json({ error: '密码错误次数过多，已锁定15分钟' });
        } else {
          db.prepare('UPDATE user_auth SET failed_attempts=? WHERE id=1').run(fails);
          res.status(401).json({ error: `密码错误（${fails}/5）` });
        }
        return;
      }
      db.prepare('UPDATE user_auth SET failed_attempts=0, locked_until=NULL WHERE id=1').run();
      res.json({ ok: true, token: 'session-' + Date.now() });
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
 *   const { AiProvider, DocAgent, READ_TOOLS } = await import('@doc77/ai');
 *   app.post('/api/ai/chat', createAIChatHandler({ AiProvider, DocAgent, READ_TOOLS }));
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
    ): AsyncIterable<
      | { type: 'token'; content: string }
      | { type: 'tool_call'; name: string; arguments: string; status: string }
      | { type: 'done' }
      | { type: 'error'; message: string }
    >;
  };
  READ_TOOLS: unknown[];
}) {
  const { AiProvider, DocAgent, READ_TOOLS } = deps;

  return async (req: Request, res: Response) => {
    const { message, project_id, session_id } = req.body;
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
        const baseUrl = baseRow?.value || 'https://api.openai.com/v1';
        const model = modelRow?.value || 'gpt-4o';
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
      res
        .status(400)
        .json({ error: 'AI_NOT_CONFIGURED', message: '请先在设置中配置 AI 模型和 API Token' });
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
      const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const pid = (args.project_id as number) || project_id;
        if (!pid) return 'Error: project_id is required';
        switch (name) {
          case 'list_files': {
            const dirPath = (args.dir_path as string) || '';
            const result = scanDirectory(pid, dirPath);
            const entries = result.entries.slice(0, 50);
            if (entries.length === 0) return `目录 "${dirPath || '/'}" 为空或不存在`;
            return entries
              .map(
                (e) =>
                  `${e.type === 'directory' ? '📁' : '📄'} ${e.name} (${e.type}, ${e.size ?? 'N/A'} bytes)`,
              )
              .join('\n');
          }
          case 'read_file': {
            const filePath = args.file_path as string;
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
          }
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
          default:
            return `Error: Unknown tool "${name}"`;
        }
      };

      const provider = new AiProvider({
        apiKey: cfg.token,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
      });
      const { sessionId: sid, agent } = getOrCreateSession(
        session_id,
        () =>
          new DocAgent({
            provider,
            model: cfg.model,
            tools: READ_TOOLS as any[],
            executeTool,
            maxSteps: 5,
          }) as any,
        project_id,
      );

      if (project_id && !(agent as any).hasContext) {
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
          (agent as any).addContext(
            `当前项目: ${proj?.name || 'Unknown'} (路径: ${proj?.path || 'N/A'})\n根目录内容:\n${fileList || '(空目录)'}`,
          );
        } catch {
          /* non-fatal */
        }
      }

      send('session', { session_id: sid });

      for await (const chunk of (agent as any).chatStream(message)) {
        switch (chunk.type) {
          case 'token':
            send('token', { text: chunk.content });
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      send('error', { message: `AI 服务异常: ${msg}` });
    }

    res.end();
  };
}
