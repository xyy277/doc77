import type { DatabaseCompat } from '../db/connection.js';
import { getConnection } from '../db/connection.js';

/**
 * 相关文档评分（v1.2.0）。
 *
 * MVP 用 co-citation（共同引用）：B 与 A 共享的出链/入链越多越相关。
 *   score(B) = |out(A) ∩ out(B)| + |in(A) ∩ in(B)|
 * 并列 tie-break 用 B 的入链总数（被引用越多越"核心"）。
 *
 * 接口类型化（RelatedScorer）供第三阶段注入 RAG 语义融合评分。
 */

export interface ScoredDoc {
  path: string;
  title: string;
  score: number;
}

export type RelatedScorer = (
  conn: DatabaseCompat,
  projectId: number,
  path: string,
  limit: number,
) => ScoredDoc[];

function setOf(rows: Array<Record<string, string>>, key: 'to_path' | 'from_path'): Set<string> {
  return new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string'));
}

export const coCitationScorer: RelatedScorer = (
  conn: DatabaseCompat,
  projectId: number,
  path: string,
  limit: number,
): ScoredDoc[] => {
  // A 的出链目标集合
  const outA = setOf(
    conn
      .prepare(
        "SELECT to_path FROM doc_links WHERE project_id = ? AND from_path = ? AND status = 'resolved'",
      )
      .all(projectId, path) as Array<{ to_path: string }>,
    'to_path',
  );
  // A 的入链来源集合
  const inA = setOf(
    conn
      .prepare(
        "SELECT from_path FROM doc_links WHERE project_id = ? AND to_path = ? AND status = 'resolved'",
      )
      .all(projectId, path) as Array<{ from_path: string }>,
    'from_path',
  );

  // 候选 = 与 A 共享引用（co-citation）的所有文档（二阶邻居）：
  //   共享出链：引用过 out(A) 中任一目标的文档
  //   共享入链：被 in(A) 中任一来源引用过的文档
  // ∪ A 的 1 跳直接邻居（出链目标 + 入链来源，低分兜底 ——
  //   被多人引用的"中心节点"其相关文档就是直接引用者）。
  // 排除 A 自身。
  const candidates = new Set<string>([...outA, ...inA]);
  if (outA.size > 0) {
    const ph = Array.from(outA)
      .map(() => '?')
      .join(',');
    const rows = conn
      .prepare(
        `SELECT DISTINCT from_path FROM doc_links
         WHERE project_id = ? AND status = 'resolved' AND to_path IN (${ph})`,
      )
      .all(projectId, ...Array.from(outA)) as Array<{ from_path: string }>;
    for (const r of rows) candidates.add(r.from_path);
  }
  if (inA.size > 0) {
    const ph = Array.from(inA)
      .map(() => '?')
      .join(',');
    const rows = conn
      .prepare(
        `SELECT DISTINCT to_path FROM doc_links
         WHERE project_id = ? AND status = 'resolved' AND from_path IN (${ph})`,
      )
      .all(projectId, ...Array.from(inA)) as Array<{ to_path: string }>;
    for (const r of rows) candidates.add(r.to_path);
  }
  candidates.delete(path);

  // 每候选的 in-count（tie-break）
  const inCount = new Map<string, number>();
  if (candidates.size > 0) {
    const placeholders = Array.from(candidates)
      .map(() => '?')
      .join(',');
    const rows = conn
      .prepare(
        `SELECT to_path, COUNT(*) AS c FROM doc_links
         WHERE project_id = ? AND status = 'resolved' AND to_path IN (${placeholders})
         GROUP BY to_path`,
      )
      .all(projectId, ...Array.from(candidates)) as Array<{ to_path: string; c: number }>;
    for (const r of rows) inCount.set(r.to_path, r.c);
  }

  const scored: ScoredDoc[] = [];
  for (const b of candidates) {
    // |out(A) ∩ out(B)| + |in(A) ∩ in(B)|
    const outB = setOf(
      conn
        .prepare(
          "SELECT to_path FROM doc_links WHERE project_id = ? AND from_path = ? AND status = 'resolved'",
        )
        .all(projectId, b) as Array<{ to_path: string }>,
      'to_path',
    );
    const inB = setOf(
      conn
        .prepare(
          "SELECT from_path FROM doc_links WHERE project_id = ? AND to_path = ? AND status = 'resolved'",
        )
        .all(projectId, b) as Array<{ from_path: string }>,
      'from_path',
    );
    let score = 0;
    for (const t of outA) if (outB.has(t)) score++;
    for (const s of inA) if (inB.has(s)) score++;
    scored.push({
      path: b,
      title: '',
      // 主分 co-citation（共享引用数 ×1000，tie-break 入链数）；
      // 无共享引用的一跳直接邻居 score=1 兜底（排在共享引用之后）
      score: score > 0 ? score * 1000 + (inCount.get(b) ?? 0) : 1,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  // 批量补 title（doc_meta）
  if (top.length > 0) {
    const placeholders = top.map(() => '?').join(',');
    const rows = conn
      .prepare(
        `SELECT file_path, title FROM doc_meta WHERE project_id = ? AND file_path IN (${placeholders})`,
      )
      .all(projectId, ...top.map((s) => s.path)) as Array<{ file_path: string; title: string }>;
    const titles = new Map(rows.map((r) => [r.file_path, r.title]));
    for (const s of top) s.title = titles.get(s.path) ?? s.path;
    for (const s of top) s.score = Math.round(s.score / 1000); // 归一化回 co-citation 分
  }

  return top;
};

/** 便捷包装（默认连接） */
export function relatedDocs(
  projectId: number,
  path: string,
  limit = 5,
  scorer: RelatedScorer = coCitationScorer,
): ScoredDoc[] {
  return scorer(getConnection(), projectId, path, limit);
}
