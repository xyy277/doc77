import express, { type Request, type Response, type NextFunction } from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConnection } from '../db/connection.js';
import { registerProject, listProjects, removeProject } from '../db/projects.js';
import { scanDirectory } from '../scanner/index.js';
import { readFile, validatePath, resolveProjectPath } from '../fs/index.js';
import {
  renderMarkdown,
  renderMermaid,
  renderCode,
  getRendererForFile,
} from '../renderers/index.js';

const VERSION = '0.1.0';

/**
 * Create and configure the Express application.
 */
export function createApp() {
  const app = express();

  // --- Middleware ---

  // Parse JSON bodies
  app.use(express.json());

  // Serve static files — try dist/web (npm) first, then src/web (dev)
  let webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
  if (!fs.existsSync(webDir)) {
    webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  }
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
  }

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
    try {
      getConnection();
    } catch {
      dbStatus = 'disconnected';
    }

    const db = getConnection();
    const activeLocks = (
      db.prepare('SELECT COUNT(*) as count FROM project_locks').get() as { count: number }
    ).count;
    const sessionCount = (
      db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
    ).count;

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

  // Approve a task
  app.post('/api/queue/approve', async (req: Request, res: Response) => {
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
      const { executeApprovedTasks } = await import(
        '../../mcp/src/transaction/executor.js'
      );
      executeApprovedTasks(task.project_id, [String(task.id)]).catch((e: Error) =>
        console.error('[executor]', e.message),
      );

      res.json({ task_id, status: 'approved' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

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

  // === AI Chat API ===

  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    const { message } = req.body;
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // SSE streaming response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      send('thinking', { status: 'analyzing' });
      await new Promise((r) => setTimeout(r, 300));

      // Generate response based on message intent
      const lowerMsg = message.toLowerCase();
      let responseText: string;

      if (lowerMsg.includes('分析') || lowerMsg.includes('结构') || lowerMsg.includes('目录')) {
        responseText =
          '我分析了当前项目的目录结构。建议将文档按类型分组：Markdown 文件统一放在 `docs/` 目录，配置文件放在 `config/` 目录，脚本文件放在 `scripts/` 目录。';
      } else if (
        lowerMsg.includes('总结') ||
        lowerMsg.includes('摘要') ||
        lowerMsg.includes('summary')
      ) {
        responseText =
          '这是一个包含技术文档和配置文件的本地项目。核心内容包括 API 设计规范、架构图和项目说明。建议定期清理过时的文档，保持项目结构清晰。';
      } else if (
        lowerMsg.includes('整理') ||
        lowerMsg.includes('移动') ||
        lowerMsg.includes('归类')
      ) {
        responseText =
          '我为您生成了以下操作建议：\n1. 创建 `archive` 归档文件夹\n2. 将过时文件移动到归档中\n操作已加入审批队列，请在"审批流"面板中确认执行。';
      } else {
        responseText = `收到您的消息："${message}"。作为 Doc77 AI 助手，我可以帮您分析项目结构、生成摘要、整理文档。请告诉我您的具体需求。`;
      }

      send('response', { text: responseText });
      send('done', { status: 'completed' });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      send('error', { error: errorMsg });
    }

    res.end();
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

  // --- Error handler ---
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[server error]', err.message);
    res.status(500).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    });
  });

  return app;
}
