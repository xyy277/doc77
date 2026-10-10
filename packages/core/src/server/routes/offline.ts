import { type Request, type Response, type Express } from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConnection } from '../../db/connection.js';
import { walkDirAsync } from '../../search/indexer.js';
import { isUnsupportedFormat } from '../../renderers/index.js';

/**
 * 离线缓存清单（spec 01 §4.1 Phase 2）。
 * 返回项目内**可离线缓存的文档清单**（路径/大小/修改时间），供前端 SW 与
 * 设置页比对本地缓存状态、按需预缓存。断网时已缓存文档可读（只读）。
 *
 * 设计要点：
 * - 只列出渲染器支持的文档（图片/PDF/office/code/markdown 等），
 *   排除不支持的二进制格式（列出也无意义，SW 不会缓存其内容）
 * - walkDirAsync 异步遍历（10k 文件同步 walkDir ≈ 400ms 会阻塞事件循环）
 * - 条目数上限保护（默认 2000 / 最大 10000）+ truncated 标志，
 *   避免超大项目把响应序列化成数十 MB
 */

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 10000;

interface ProjectRow {
  id: number;
  name: string;
  path: string;
}

interface ManifestEntry {
  project_id: number;
  path: string;
  title: string;
  size: number;
  modified: string;
}

function parseIntStrict(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 可离线缓存 = 渲染器支持的文档（与预览能力范围一致） */
function isCacheableDoc(relPath: string): boolean {
  return !isUnsupportedFormat(relPath);
}

export function registerOfflineRoutes(app: Express): void {
  // ── GET /api/offline/manifest?projectId=&limit= ──
  app.get('/api/offline/manifest', async (req: Request, res: Response) => {
    try {
      const db = getConnection();

      // 项目范围：指定 projectId 或全部
      const rawId = req.query.projectId;
      let projects: ProjectRow[];
      if (rawId !== undefined && rawId !== '') {
        const id = parseIntStrict(String(rawId));
        if (id === null) {
          res.status(400).json({ error: 'Invalid projectId', code: 'BAD_REQUEST' });
          return;
        }
        const row = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(id) as
          ProjectRow | undefined;
        if (!row) {
          res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
          return;
        }
        projects = [row];
      } else {
        projects = db
          .prepare('SELECT id, name, path FROM projects ORDER BY id')
          .all() as ProjectRow[];
      }

      // limit 严格解析 + clamp
      const rawLimit =
        req.query.limit === undefined ? DEFAULT_LIMIT : parseIntStrict(String(req.query.limit));
      const limit = rawLimit === null ? DEFAULT_LIMIT : Math.max(1, Math.min(rawLimit, MAX_LIMIT));

      const documents: ManifestEntry[] = [];
      const summaries: Array<{ id: number; name: string; documents: number }> = [];
      let truncated = false;

      for (const p of projects) {
        let relFiles: string[] = [];
        try {
          relFiles = await walkDirAsync(p.path, p.path);
        } catch {
          summaries.push({ id: p.id, name: p.name, documents: 0 });
          continue;
        }
        const cacheable = relFiles.filter(isCacheableDoc);
        summaries.push({ id: p.id, name: p.name, documents: cacheable.length });

        for (const rel of cacheable) {
          if (documents.length >= limit) {
            truncated = true;
            break;
          }
          let st: fs.Stats;
          try {
            st = await fs.promises.stat(path.join(p.path, rel));
          } catch {
            continue; // 竞态删除/权限不足 → 跳过该条
          }
          if (!st.isFile()) continue;
          const base = rel.split('/').pop() || rel;
          documents.push({
            project_id: p.id,
            path: rel,
            title: base.replace(/\.[^.]+$/, ''),
            size: st.size,
            modified: st.mtime.toISOString(),
          });
        }
        if (truncated) break;
      }

      res.json({
        generated_at: new Date().toISOString(),
        total: documents.length,
        total_bytes: documents.reduce((sum, d) => sum + d.size, 0),
        truncated,
        projects: summaries,
        documents,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      res.status(500).json({ error: msg, code: 'OFFLINE_MANIFEST_FAILED' });
    }
  });
}
