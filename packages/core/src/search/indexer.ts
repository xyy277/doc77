/**
 * Full-text search indexer — builds and maintains FTS5 index.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getConnection, type DatabaseCompat } from '../db/connection.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.text', '.markdown',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.conf', '.cfg',
  '.html', '.htm', '.xml', '.svg', '.css', '.scss', '.less',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.sql', '.graphql', '.proto', '.csv', '.log',
  '.gitignore', '.editorconfig', '.prettierrc',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.idea', '.vs',
  'coverage', '.cache', '.doc77',
]);

export function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(base);
}

function fileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function extractTitle(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown') {
    const match = content.match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
  }
  return path.basename(filePath);
}

/** Strip HTML tags for indexing */
function stripHtml(content: string): string {
  return content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

export interface IndexProgress {
  indexed: number;
  total: number;
  skipped: number;
  errors: number;
}

/**
 * Index a single file (incremental update).
 */
export function indexFile(
  projectId: number,
  projectRoot: string,
  relativePath: string,
  db?: DatabaseCompat,
): boolean {
  const conn = db ?? getConnection();
  const absPath = path.join(projectRoot, relativePath);

  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_SIZE) return false;

    let content = fs.readFileSync(absPath, 'utf-8');
    const ext = path.extname(relativePath).toLowerCase();
    if (ext === '.html' || ext === '.htm' || ext === '.xml' || ext === '.svg') {
      content = stripHtml(content);
    }

    const hash = fileHash(content);
    const mtime = stat.mtime.toISOString();

    // Check if already indexed with same hash
    const meta = conn
      .prepare('SELECT file_hash FROM search_index_meta WHERE project_id = ? AND file_path = ?')
      .get(projectId, relativePath) as { file_hash: string } | undefined;

    if (meta && meta.file_hash === hash) return false; // unchanged

    // Delete old entry
    conn.prepare('DELETE FROM file_content_fts WHERE project_id = ? AND file_path = ?')
      .run(projectId, relativePath);

    // Insert new
    const title = extractTitle(content, relativePath);
    conn.prepare('INSERT INTO file_content_fts (project_id, file_path, title, content) VALUES (?, ?, ?, ?)')
      .run(projectId, relativePath, title, content);

    // Upsert meta
    conn.prepare(`
      INSERT INTO search_index_meta (project_id, file_path, file_hash, file_mtime, file_size, indexed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id, file_path) DO UPDATE SET
        file_hash = excluded.file_hash,
        file_mtime = excluded.file_mtime,
        file_size = excluded.file_size,
        indexed_at = excluded.indexed_at
    `).run(projectId, relativePath, hash, mtime, stat.size);

    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a file from the index.
 */
export function removeFileFromIndex(
  projectId: number,
  relativePath: string,
  db?: DatabaseCompat,
): void {
  const conn = db ?? getConnection();
  conn.prepare('DELETE FROM file_content_fts WHERE project_id = ? AND file_path = ?')
    .run(projectId, relativePath);
  conn.prepare('DELETE FROM search_index_meta WHERE project_id = ? AND file_path = ?')
    .run(projectId, relativePath);
}

/**
 * Remove all indexed files for a project.
 */
export function clearProjectIndex(projectId: number, db?: DatabaseCompat): void {
  const conn = db ?? getConnection();
  conn.prepare('DELETE FROM file_content_fts WHERE project_id = ?').run(projectId);
  conn.prepare('DELETE FROM search_index_meta WHERE project_id = ?').run(projectId);
}

/**
 * Full index for a project (background, batched).
 */
export async function fullIndex(
  projectId: number,
  projectRoot: string,
  onProgress?: (p: IndexProgress) => void,
  db?: DatabaseCompat,
): Promise<IndexProgress> {
  const conn = db ?? getConnection();
  const progress: IndexProgress = { indexed: 0, total: 0, skipped: 0, errors: 0 };

  // Walk directory
  const files = walkDir(projectRoot, projectRoot);
  const textFiles = files.filter((f) => isTextFile(f));
  progress.total = textFiles.length;

  // Batch index (100 files per transaction)
  const BATCH_SIZE = 100;
  for (let i = 0; i < textFiles.length; i += BATCH_SIZE) {
    const batch = textFiles.slice(i, i + BATCH_SIZE);
    conn.exec('BEGIN');
    try {
      for (const relPath of batch) {
        const changed = indexFile(projectId, projectRoot, relPath, conn);
        if (changed) progress.indexed++;
        else progress.skipped++;
      }
      conn.exec('COMMIT');
    } catch {
      try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
      progress.errors += batch.length;
    }

    if (onProgress) onProgress({ ...progress });
    // Yield to event loop
    await new Promise((r) => setTimeout(r, 0));
  }

  // Cleanup: remove entries for files that no longer exist
  const existing = conn
    .prepare('SELECT file_path FROM search_index_meta WHERE project_id = ?')
    .all(projectId) as { file_path: string }[];
  const fileSet = new Set(textFiles);
  for (const row of existing) {
    if (!fileSet.has(row.file_path)) {
      removeFileFromIndex(projectId, row.file_path, conn);
    }
  }

  return progress;
}

/**
 * Get index stats for a project.
 */
export function getIndexStats(projectId: number, db?: DatabaseCompat) {
  const conn = db ?? getConnection();
  const row = conn
    .prepare('SELECT COUNT(*) as count, MAX(indexed_at) as last_indexed FROM search_index_meta WHERE project_id = ?')
    .get(projectId) as { count: number; last_indexed: string | null } | undefined;
  return {
    totalFiles: row?.count ?? 0,
    lastIndexed: row?.last_indexed ?? null,
  };
}

function walkDir(root: string, dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(root, fullPath));
      } else if (entry.isFile()) {
        results.push(path.relative(root, fullPath).replace(/\\/g, '/'));
      }
    }
  } catch { /* permission denied etc. */ }
  return results;
}
