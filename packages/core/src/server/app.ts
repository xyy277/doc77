import express, { type Request, type Response, type NextFunction } from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { exec, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConnection } from '../db/connection.js';
import { registerProject, listProjects, removeProject } from '../db/projects.js';
import { scanDirectory } from '../scanner/index.js';
import { readFile, validatePath, resolveProjectPath } from '../fs/index.js';
import * as crypto from '../crypto.js';
import {
  renderMarkdown,
  renderMermaid,
  renderCode,
  getRendererForFile,
} from '../renderers/index.js';
import { AiProvider, DocAgent, READ_TOOLS } from '@doc77/ai';
import { getOrCreateSession, resetSession } from './sessions.js';

const VERSION = '0.1.0';

/**
 * Create and configure the Express application.
 */
export function createApp() {
  const app = express();

  // --- Middleware ---

  // Parse JSON bodies
  app.use(express.json());

  // Serve static files — try multiple paths for dev / npm / monorepo layouts
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const webCandidates = [
    path.join(moduleDir, 'web'),              // dist/web/ (npm publish layout)
    path.join(moduleDir, '..', 'web'),        // src/web/ (dev via src/server/)
    path.join(moduleDir, '..', 'src', 'web'), // resolve from dist/ to src/web/
  ];
  let webDir = '';
  for (const candidate of webCandidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      webDir = candidate;
      break;
    }
  }
  if (webDir) {
    app.use(express.static(webDir));
  }

  // Explicit GET / route — always mounted regardless of static file discovery
  app.get('/', (_req: Request, res: Response) => {
    if (webDir) {
      const indexPath = path.join(webDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
        return;
      }
    }
    // Ultimate fallback: inline HTML ensures the homepage never 404s
    res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Doc77</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc">
<div style="text-align:center">
<h1 style="color:#1e293b;font-size:2rem;margin-bottom:.5rem">📁 Doc77</h1>
<p style="color:#64748b">Dashboard is running.</p>
<p style="color:#94a3b8;font-size:14px">Run <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px">pnpm build</code> in the workspace root to rebuild the web assets.</p>
</div></body></html>`);
  });

  // CORS — allow all origins (localhost-only binding for security)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // --- API Routes ---

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

  // Project CRUD
  app.get('/api/projects', (_req: Request, res: Response) => {
    const projects = listProjects();
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

  // File content with renderer dispatch
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
      // Get project root
      const db = getConnection();
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
        { path: string } | undefined;

      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Validate and read file
      const absPath = validatePath(project.path, filePath);
      const rawContent = readFile(absPath);
      const rendererType = getRendererForFile(filePath);

      let content: string;
      switch (rendererType) {
        case 'markdown':
          content = renderMarkdown(rawContent);
          break;
        case 'mermaid':
          content = renderMermaid(rawContent);
          break;
        case 'code':
          content = renderCode(rawContent, path.extname(filePath).slice(1));
          break;
        case 'image':
        case 'pdf':
          // For binary files, return a raw URL instead of inline content
          res.json({
            path: filePath,
            type: rendererType,
            rawUrl: `/api/raw/${projectId}?path=${encodeURIComponent(filePath)}`,
          });
          return;
        default:
          content = rawContent;
      }

      res.json({
        path: filePath,
        type: rendererType,
        content,
      });
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
      const project = db
        .prepare('SELECT path FROM projects WHERE id = ?')
        .get(projectId) as { path: string } | undefined;

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
        '.pdf': 'application/pdf',
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
  // (helper for reading & decrypting AI config — also used by /api/ai/chat)

  function getDecryptedAiConfig(): { token: string; baseUrl: string; model: string } | null {
    const db = getConnection();
    const tokenRow = db.prepare("SELECT value FROM config WHERE key = 'ai.token'").get() as { value: string } | undefined;
    const baseRow = db.prepare("SELECT value FROM config WHERE key = 'ai.base_url'").get() as { value: string } | undefined;
    const modelRow = db.prepare("SELECT value FROM config WHERE key = 'ai.model'").get() as { value: string } | undefined;

    if (!tokenRow?.value) return null;

    const baseUrl = baseRow?.value || 'https://api.openai.com/v1';
    const model = modelRow?.value || 'gpt-4o';

    let token = tokenRow.value;
    if (token.startsWith('{')) {
      try {
        const encData = JSON.parse(token);
        if (encData.iv && encData.tag && encData.ciphertext) {
          const authRow = db.prepare('SELECT pbkdf2_salt FROM user_auth WHERE id = 1').get() as { pbkdf2_salt: string } | undefined;
          if (authRow?.pbkdf2_salt) {
            const encKey = crypto.deriveKey('doc77-config-key', Buffer.from(authRow.pbkdf2_salt, 'hex'));
            token = crypto.decrypt(encData, encKey);
          }
        }
      } catch { /* not encrypted */ }
    }

    return { token, baseUrl, model };
  }

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
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
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

  // === AI Chat API (real — SSE streaming with tool-use) ===

  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    const { message, project_id, session_id } = req.body;
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // Check AI config
    const cfg = getDecryptedAiConfig();
    if (!cfg) {
      res.status(400).json({ error: 'AI_NOT_CONFIGURED', message: '请先在设置中配置 AI 模型和 API Token' });
      return;
    }

    // SSE headers
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
      // Tool executor — bridges AI agent to MCP read functions
      const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const pid = (args.project_id as number) || project_id;
        if (!pid) return 'Error: project_id is required for tool execution';

        switch (name) {
          case 'list_files': {
            const dirPath = (args.dir_path as string) || '';
            const result = scanDirectory(pid, dirPath);
            const entries = result.entries.slice(0, 50); // limit to 50 entries
            if (entries.length === 0) return `目录 "${dirPath || '/'}" 为空或不存在`;
            return entries
              .map((e) => `${e.type === 'directory' ? '📁' : '📄'} ${e.name} (${e.type}, ${e.size ?? 'N/A'} bytes)`)
              .join('\n');
          }
          case 'read_file': {
            const filePath = args.file_path as string;
            if (!filePath) return 'Error: file_path is required';
            // Security: reject sensitive files
            const fileName = filePath.split('/').pop() || filePath;
            if (isSensitiveFile(fileName)) return `Error: Access denied — "${fileName}" is a sensitive file`;
            try {
              const db = getConnection();
              const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as { path: string } | undefined;
              if (!project) return 'Error: Project not found';
              const absPath = validatePath(project.path, filePath);
              const content = readFile(absPath);
              // Truncate to ~4000 chars for LLM context
              return content.length > 4000
                ? content.slice(0, 4000) + `\n\n[... truncated, total ${content.length} chars]`
                : content;
            } catch (e: unknown) {
              return `Error reading file: ${e instanceof Error ? e.message : 'Unknown error'}`;
            }
          }
          case 'get_file_info': {
            const filePath = args.file_path as string;
            if (!filePath) return 'Error: file_path is required';
            try {
              const db = getConnection();
              const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as { path: string } | undefined;
              if (!project) return 'Error: Project not found';
              const absPath = validatePath(project.path, filePath);
              const stats = fs.statSync(absPath);
              return `File: ${filePath}\nType: ${stats.isDirectory() ? 'directory' : 'file'}\nSize: ${stats.size} bytes\nModified: ${stats.mtime.toISOString()}`;
            } catch (e: unknown) {
              return `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
            }
          }
          default:
            return `Error: Unknown tool "${name}"`;
        }
      };

      // Build project context for first message in session
      const provider = new AiProvider({ apiKey: cfg.token, baseUrl: cfg.baseUrl, model: cfg.model });
      const { sessionId: sid, agent } = getOrCreateSession(
        session_id,
        () => new DocAgent({ provider, model: cfg.model, tools: READ_TOOLS, executeTool, maxSteps: 5 }),
        project_id,
      );

      // Inject project context on first message for this session
      if (project_id && !agent.hasContext) {
        try {
          const root = scanDirectory(project_id, '');
          const fileList = root.entries.slice(0, 30).map(e => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}`).join('\n');
          const proj = (() => {
            const db = getConnection();
            return db.prepare('SELECT name, path FROM projects WHERE id = ?').get(project_id) as { name: string; path: string } | undefined;
          })();
          agent.addContext(`当前项目: ${proj?.name || 'Unknown'} (路径: ${proj?.path || 'N/A'})\n根目录内容:\n${fileList || '(空目录)'}`);
        } catch { /* context injection failure is non-fatal */ }
      }

      // Send session_id so frontend can reuse it
      send('session', { session_id: sid });

      // Stream conversation
      for await (const chunk of agent.chatStream(message)) {
        switch (chunk.type) {
          case 'token':
            send('token', { text: chunk.content });
            break;
          case 'tool_call':
            send('tool_call', { name: chunk.name, arguments: chunk.arguments, status: 'executing' });
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

  // === Search API ===

  // Full-text search via grep
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
      const project = db
        .prepare('SELECT path FROM projects WHERE id = ?')
        .get(projectId) as { path: string } | undefined;

      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const result = execFileSync(
        'grep',
        ['-rnIs', '--exclude-dir=node_modules', '--exclude-dir=.git', '-m', '50', keyword, project.path],
        { encoding: 'utf-8', timeout: 5000 },
      );

      const matches = result
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [file, lineNum, ...rest] = line.split(':');
          return {
            file: file.replace(project.path + '/', ''),
            line: parseInt(lineNum, 10),
            content: rest.join(':').substring(0, 200),
          };
        });

      res.json({ keyword, matches });
    } catch (err: unknown) {
      // grep returns exit code 1 when no matches — not an error
      if ((err as any)?.code === 1 || (err as any)?.status === 1) {
        res.json({ keyword, matches: [] });
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // === Auth API ===

  // Check auth status
  app.get('/api/auth/status', (_req: Request, res: Response) => {
    try {
      const db = getConnection();
      const row = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as { password_hash: string } | undefined;
      res.json({ hasPassword: !!row?.password_hash });
    } catch { res.json({ hasPassword: false }); }
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
      const existing = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as { password_hash: string } | undefined;
      if (existing?.password_hash) {
        res.status(409).json({ error: '密码已设置，请使用修改密码功能' });
        return;
      }
      const hash = crypto.hashPassword(password);
      const encSalt = crypto.generateSalt().toString('hex');
      const pbkdf2Salt = crypto.generateSalt().toString('hex');
      db.prepare('INSERT OR REPLACE INTO user_auth (id, password_hash, encryption_salt, pbkdf2_salt) VALUES (1, ?, ?, ?)').run(hash, encSalt, pbkdf2Salt);
      res.json({ ok: true });
    } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Login
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password) { res.status(400).json({ error: '密码不能为空' }); return; }
    try {
      const db = getConnection();
      const row = db.prepare('SELECT * FROM user_auth WHERE id = 1').get() as Record<string, unknown> | undefined;
      if (!row?.password_hash) { res.status(404).json({ error: '未设置密码' }); return; }
      if (row.locked_until && new Date(row.locked_until as string) > new Date()) {
        res.status(423).json({ error: '账户已锁定，请稍后再试' }); return;
      }
      if (!crypto.verifyPassword(password, row.password_hash as string)) {
        const fails = ((row.failed_attempts as number) || 0) + 1;
        if (fails >= 5) {
          db.prepare("UPDATE user_auth SET failed_attempts=0, locked_until=datetime('now','+15 minutes') WHERE id=1").run();
          res.status(423).json({ error: '密码错误次数过多，已锁定15分钟' });
        } else {
          db.prepare('UPDATE user_auth SET failed_attempts=? WHERE id=1').run(fails);
          res.status(401).json({ error: `密码错误（${fails}/5）` });
        }
        return;
      }
      db.prepare('UPDATE user_auth SET failed_attempts=0, locked_until=NULL WHERE id=1').run();
      res.json({ ok: true, token: 'session-' + Date.now() });
    } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
  });

  // === Config API ===

  app.get('/api/config', (_req: Request, res: Response) => {
    try {
      const db = getConnection();
      const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all() as { key: string; value: string }[];
      const result: Record<string, string> = {};
      for (const r of rows) {
        result[r.key] = crypto.isSensitiveKey(r.key) ? crypto.maskSensitive(r.value) : r.value;
      }
      res.json(result);
    } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.put('/api/config', (req: Request, res: Response) => {
    const { key, value } = req.body;
    if (!key || value === undefined) { res.status(400).json({ error: 'key and value required' }); return; }
    try {
      const db = getConnection();
      let storeValue = value;
      // Encrypt sensitive fields
      if (crypto.isSensitiveKey(key)) {
        const authRow = db.prepare('SELECT pbkdf2_salt FROM user_auth WHERE id = 1').get() as { pbkdf2_salt: string } | undefined;
        if (authRow?.pbkdf2_salt) {
          // Use a fixed passphrase for config encryption (derived from user password if available)
          // For now, store encrypted with a local key
          const encKey = crypto.deriveKey('doc77-config-key', Buffer.from(authRow.pbkdf2_salt, 'hex'));
          const enc = crypto.encrypt(value, encKey);
          storeValue = JSON.stringify(enc);
        }
      }
      db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, storeValue);
      res.json({ ok: true, key });
    } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
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
        | { id: number; project_id: number; operation_type: string; status: string }
        | undefined;

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
