/**
 * Full-text search query builder + snippet highlighting.
 */
import { getConnection, type DatabaseCompat } from '../db/connection.js';

export interface SearchResult {
  file_path: string;
  title: string;
  score: number;
  snippets: string[];
  modified: string | null;
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
  indexStats: { totalFiles: number; lastIndexed: string | null };
}

/**
 * Sanitize FTS5 query to prevent injection.
 * Allows: words, quotes, AND/OR/NOT, *, prefix
 */
function sanitizeFtsQuery(q: string): string {
  // Remove dangerous characters but keep FTS5 operators
  let sanitized = q.replace(/[;{}()\\]/g, ' ').trim();
  if (!sanitized) return '';

  // If no explicit operators, wrap each word with * for prefix matching
  if (!/\b(AND|OR|NOT)\b/.test(sanitized) && !sanitized.includes('"')) {
    const words = sanitized.split(/\s+/).filter(Boolean);
    sanitized = words.map((w) => {
      if (w.startsWith('"') || w.includes('*')) return w;
      return `"${w}"*`;
    }).join(' OR ');
  }
  return sanitized;
}

/**
 * Generate text snippets with highlighted matches.
 */
function generateSnippets(content: string, query: string, maxSnippets = 3): string[] {
  const snippets: string[] = [];
  const lowerContent = content.toLowerCase();
  const terms = query.replace(/["]/g, '').split(/\s+/).filter((t) => t.length > 1 && !['AND', 'OR', 'NOT'].includes(t.toUpperCase()));

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    let idx = lowerContent.indexOf(lowerTerm);
    let count = 0;
    while (idx !== -1 && count < maxSnippets) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(content.length, idx + term.length + 60);
      let snippet = content.slice(start, end).replace(/\n/g, ' ').trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < content.length) snippet = snippet + '...';
      // Highlight
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      snippet = snippet.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
      snippets.push(snippet);
      count++;
      idx = lowerContent.indexOf(lowerTerm, idx + term.length);
    }
  }
  return snippets.slice(0, maxSnippets);
}

/**
 * Search within a single project.
 */
export function searchProject(
  projectId: number,
  query: string,
  options: { limit?: number; offset?: number; pathFilter?: string } = {},
  db?: DatabaseCompat,
): SearchResponse {
  const conn = db ?? getConnection();
  const { limit = 20, offset = 0, pathFilter } = options;

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) {
    return { query, total: 0, results: [], indexStats: { totalFiles: 0, lastIndexed: null } };
  }

  try {
    // Count total
    let countSql = `SELECT COUNT(*) as cnt FROM file_content_fts WHERE file_content_fts MATCH ? AND project_id = ?`;
    let countParams: unknown[] = [ftsQuery, projectId];
    if (pathFilter) {
      countSql += ` AND file_path LIKE ?`;
      countParams.push(pathFilter + '%');
    }
    const countRow = conn.prepare(countSql).get(...countParams) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    // Fetch results with rank
    let sql = `
      SELECT file_path, title, content, rank
      FROM file_content_fts
      WHERE file_content_fts MATCH ? AND project_id = ?
    `;
    const params: unknown[] = [ftsQuery, projectId];
    if (pathFilter) {
      sql += ` AND file_path LIKE ?`;
      params.push(pathFilter + '%');
    }
    sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = conn.prepare(sql).all(...params) as Array<{
      file_path: string;
      title: string;
      content: string;
      rank: number;
    }>;

    // Get mtime from meta
    const metaStmt = conn.prepare('SELECT file_mtime FROM search_index_meta WHERE project_id = ? AND file_path = ?');

    const results: SearchResult[] = rows.map((row) => {
      const meta = metaStmt.get(projectId, row.file_path) as { file_mtime: string } | undefined;
      return {
        file_path: row.file_path,
        title: row.title,
        score: Math.abs(row.rank),
        snippets: generateSnippets(row.content, query),
        modified: meta?.file_mtime ?? null,
      };
    });

    // Index stats
    const statsRow = conn
      .prepare('SELECT COUNT(*) as count, MAX(indexed_at) as last_indexed FROM search_index_meta WHERE project_id = ?')
      .get(projectId) as { count: number; last_indexed: string | null } | undefined;

    return {
      query,
      total,
      results,
      indexStats: {
        totalFiles: statsRow?.count ?? 0,
        lastIndexed: statsRow?.last_indexed ?? null,
      },
    };
  } catch (e) {
    // FTS5 syntax error or table missing
    return { query, total: 0, results: [], indexStats: { totalFiles: 0, lastIndexed: null } };
  }
}

/**
 * Global search across all projects.
 */
export function searchAll(
  query: string,
  options: { limit?: number } = {},
  db?: DatabaseCompat,
): { query: string; groups: Array<{ project_id: number; project_name: string; total: number; results: SearchResult[] }> } {
  const conn = db ?? getConnection();
  const { limit = 10 } = options;

  const projects = conn.prepare('SELECT id, name FROM projects ORDER BY last_opened DESC').all() as Array<{ id: number; name: string }>;

  const groups: Array<{ project_id: number; project_name: string; total: number; results: SearchResult[] }> = [];

  for (const proj of projects) {
    const result = searchProject(proj.id, query, { limit }, conn);
    if (result.total > 0) {
      groups.push({
        project_id: proj.id,
        project_name: proj.name,
        total: result.total,
        results: result.results,
      });
    }
  }

  return { query, groups };
}
