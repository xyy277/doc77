import { getConnection, type DatabaseCompat } from './connection.js';

/**
 * Whether the SQLite engine supports FTS5 full-text search.
 * Detected at runtime during the first runMigrations() call.
 * When false, a regular table is created as fallback and search
 * degrades to LIKE-based queries.
 */
export let fts5Available = false;

/**
 * Helper: add a column only if it doesn't already exist.
 * SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
 * so we catch the "duplicate column name" error.
 */
function addColumnIfNotExists(
  db: DatabaseCompat,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (!msg.includes('duplicate column name')) {
      throw e;
    }
  }
}

/**
 * Detect if FTS5 extension is available in the SQLite engine.
 */
function detectFts5(db: DatabaseCompat): boolean {
  try {
    // Try to create a temporary FTS5 table to test availability
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS temp_fts5_test USING fts5(content);
      DROP TABLE temp_fts5_test;
    `);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run all schema migrations.
 * Uses IF NOT EXISTS to ensure idempotency.
 */
export function runMigrations(db?: DatabaseCompat): void {
  const conn = db ?? getConnection();
  conn.exec(SCHEMA_SQL);

  // v2: Password recovery — envelope encryption + recovery codes
  const v2Columns: Array<[string, string]> = [
    ['pw_wrap_salt', 'TEXT'],
    ['rc_wrap_salt', 'TEXT'],
    ['jwt_salt', 'TEXT'],
    ['wrapped_dek_by_password', 'TEXT'],
    ['wrapped_dek_by_recovery', 'TEXT'],
    ['recovery_code_hashes', 'TEXT'],
    ['recovery_code_index_hashes', 'TEXT'],
    ['recovery_codes_used', 'TEXT'],
    ['recovery_codes_generated_at', 'DATETIME'],
    ['recovery_attempts', 'INTEGER DEFAULT 0'],
    ['recovery_locked_until', 'DATETIME'],
  ];
  for (const [col, def] of v2Columns) {
    addColumnIfNotExists(conn, 'user_auth', col, def);
  }

  // v3: Obsidian mode support
  addColumnIfNotExists(conn, 'projects', 'obsidian_mode', 'INTEGER NOT NULL DEFAULT 0');

  // v4: Project tags (JSON array)
  addColumnIfNotExists(conn, 'projects', 'tags', "TEXT NOT NULL DEFAULT '[]'");

  // v5: Gallery tables (thumbnail cache, albums)
  conn.exec(GALLERY_SCHEMA_SQL);

  // v6: Add project_id to thumbnail_cache for cross-project isolation
  addColumnIfNotExists(conn, 'thumbnail_cache', 'project_id', 'INTEGER NOT NULL DEFAULT 0');

  // v7: Full-text search (FTS5) — detect availability first
  fts5Available = detectFts5(conn);
  conn.exec(fts5Available ? SEARCH_SCHEMA_SQL : SEARCH_SCHEMA_FALLBACK_SQL);

  // v8: Sync engine tables
  conn.exec(SYNC_SCHEMA_SQL);

  // v9: AI session redesign — message-level storage, tree branching, skill registry
  conn.exec(fts5Available ? AI_V9_SCHEMA_SQL : AI_V9_SCHEMA_FALLBACK_SQL);

  // Migrate old ai_chat_sessions data into new ai_sessions + ai_messages tables
  migrateOldAiChatSessions(conn);

  // v10: sync_keyring — 持久化 sync 模块的 masterKey 信封（密码与恢复码各包裹一次同一 masterKey）
  // 表结构：salt（密钥派生盐）、wrapped_master_by_password（密码包裹的 masterKey）、
  // wrapped_master_by_recovery（恢复码包裹的同一 masterKey）、recovery_code_hash（恢复码 SHA-256 校验值）、
  // version（协议版本号，供未来迁移使用）。单行设计 id=1。
  conn.exec(SYNC_KEYRING_SCHEMA_SQL);

  // v11: RAG 向量块存储 — T10 RAG 模块
  // embedding 存为 BLOB（Float32Array 的 Buffer），查询时全量扫描计算余弦相似度
  // 不使用 FTS5（FTS5 是关键词搜索，非向量搜索）
  conn.exec(RAG_CHUNKS_SCHEMA_SQL);

  // v12: 插件持久化 — T11 插件沙箱 + API 路由
  // 存储 enable/disable 状态、配置 JSON、安装元数据
  conn.exec(PLUGINS_SCHEMA_SQL);
}

const SCHEMA_SQL = `
-- 项目表
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    obsidian_mode INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_opened DATETIME
);

-- 配置表
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- AI 对话会话表（持久化聊天历史，重启后可恢复）
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    session_id TEXT PRIMARY KEY,
    project_id INTEGER,
    messages TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文件树缓存表
CREATE TABLE IF NOT EXISTS filetree_cache (
    project_id INTEGER NOT NULL,
    node_path TEXT NOT NULL,
    tree_json TEXT NOT NULL,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    mtime_map TEXT,
    PRIMARY KEY (project_id, node_path),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 操作队列表
CREATE TABLE IF NOT EXISTS operation_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    operation_data JSON NOT NULL,
    status TEXT DEFAULT 'pending',
    user_comment TEXT,
    undo_log JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    executed_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    operation_type TEXT NOT NULL,
    operation_data JSON NOT NULL,
    source TEXT NOT NULL,
    approved_by TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    read_count INTEGER DEFAULT 0,
    read_window_start DATETIME,
    write_count INTEGER DEFAULT 0,
    write_window_start DATETIME,
    expired_at DATETIME
);

-- 用户认证表
CREATE TABLE IF NOT EXISTS user_auth (
    id INTEGER PRIMARY KEY DEFAULT 1,
    password_hash TEXT,
    pbkdf2_salt TEXT,
    encryption_salt TEXT,
    failed_attempts INTEGER DEFAULT 0,
    locked_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 项目锁表
CREATE TABLE IF NOT EXISTS project_locks (
    project_id INTEGER PRIMARY KEY,
    locked_at DATETIME NOT NULL,
    locked_by TEXT NOT NULL,
    heartbeat_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_queue_project_id ON operation_queue(project_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON operation_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_session ON operation_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_project_id ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);

-- 项目收藏表
CREATE TABLE IF NOT EXISTS favorites (
    project_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 文件收藏表
CREATE TABLE IF NOT EXISTS file_bookmarks (
    project_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, file_path),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 最近浏览文件表
CREATE TABLE IF NOT EXISTS recent_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_favorites_created ON favorites(created_at);
CREATE INDEX IF NOT EXISTS idx_recent_files_viewed ON recent_files(viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects(last_opened);
`;

const GALLERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS thumbnail_cache (
  source_hash TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime TEXT NOT NULL,
  grid_path TEXT,
  preview_path TEXT,
  video_cover_path TEXT,
  width INTEGER,
  height INTEGER,
  exif_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_thumbnail_source_path ON thumbnail_cache(source_path);

CREATE TABLE IF NOT EXISTS gallery_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  cover_source_hash TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gallery_album_items (
  album_id INTEGER REFERENCES gallery_albums(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (album_id, project_id, file_path)
);
`;

const SEARCH_SCHEMA_SQL = `
-- Full-text search: FTS5 virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(
  project_id UNINDEXED,
  file_path UNINDEXED,
  title,
  content,
  tokenize='unicode61'
);

-- Search index metadata (track sync state)
CREATE TABLE IF NOT EXISTS search_index_meta (
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_mtime TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  indexed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_search_meta_project ON search_index_meta(project_id);
`;

/**
 * Fallback schema when FTS5 is unavailable (e.g. sql.js WASM build).
 * Creates a regular table with the same column names as the FTS5 virtual
 * table so that INSERT/DELETE statements in the indexer still work.
 * Query layer degrades to LIKE-based matching (see search/query.ts).
 */
const SEARCH_SCHEMA_FALLBACK_SQL = `
-- Fallback: regular table mirroring FTS5 columns (no full-text index)
CREATE TABLE IF NOT EXISTS file_content_fts (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  file_path TEXT,
  title TEXT,
  content TEXT
);
CREATE INDEX IF NOT EXISTS idx_fts_project_path ON file_content_fts(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_fts_content ON file_content_fts(content);

-- Search index metadata (track sync state)
CREATE TABLE IF NOT EXISTS search_index_meta (
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_mtime TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  indexed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_search_meta_project ON search_index_meta(project_id);
`;

const SYNC_SCHEMA_SQL = `
-- Sync configuration per project
CREATE TABLE IF NOT EXISTS sync_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  adapter_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  direction TEXT DEFAULT 'bidirectional',
  interval_seconds INTEGER DEFAULT 1800,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id)
);

-- Sync state tracking
CREATE TABLE IF NOT EXISTS sync_state (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'idle',
  last_sync_at TEXT,
  last_baseline TEXT,
  last_error TEXT,
  total_pushed INTEGER DEFAULT 0,
  total_pulled INTEGER DEFAULT 0,
  total_conflicts INTEGER DEFAULT 0
);

-- Sync operation log
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  direction TEXT,
  status TEXT,
  files_pushed INTEGER DEFAULT 0,
  files_pulled INTEGER DEFAULT 0,
  conflicts INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_log_project ON sync_log(project_id, created_at);
`;

/**
 * v9: AI session redesign — message-level storage with tree branching,
 * tool call audit logs, skill registry, and context compaction tracking.
 * Uses FTS5 for message content search (when available).
 */
const AI_V9_SCHEMA_SQL = `
-- AI sessions (replaces ai_chat_sessions)
CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER,
  title TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  parent_session_id TEXT,
  model TEXT,
  system_prompt_hash TEXT,
  current_leaf_id TEXT,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_session_id) REFERENCES ai_sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_project ON ai_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_status ON ai_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_pinned ON ai_sessions(pinned, updated_at DESC);

-- AI messages (tree structure with parent_id for branching)
CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  raw_json TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  reasoning TEXT,
  token_count INTEGER,
  finish_reason TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_parent ON ai_messages(parent_id);

-- AI tool call audit logs
CREATE TABLE IF NOT EXISTS ai_tool_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT,
  tool_name TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  elapsed_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_logs_session ON ai_tool_logs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_logs_tool ON ai_tool_logs(tool_name);

-- AI skill registry
CREATE TABLE IF NOT EXISTS ai_skills (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_path TEXT,
  description TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  globs TEXT,
  always_apply INTEGER DEFAULT 0,
  frontmatter_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_skills_source ON ai_skills(source, enabled);

-- AI context compaction tracking
CREATE TABLE IF NOT EXISTS ai_context_compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  before_tokens INTEGER,
  after_tokens INTEGER,
  compacted_message_ids TEXT,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);

-- FTS5 full-text search for AI messages
CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(
  content,
  content=ai_messages,
  content_rowid=rowid
);
CREATE TRIGGER IF NOT EXISTS ai_messages_fts_insert AFTER INSERT ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS ai_messages_fts_delete AFTER DELETE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS ai_messages_fts_update AFTER UPDATE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO ai_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

/**
 * Fallback v9 schema when FTS5 is unavailable — uses regular table with LIKE search.
 */
const AI_V9_SCHEMA_FALLBACK_SQL = `
-- AI sessions (replaces ai_chat_sessions)
CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER,
  title TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  parent_session_id TEXT,
  model TEXT,
  system_prompt_hash TEXT,
  current_leaf_id TEXT,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_session_id) REFERENCES ai_sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_project ON ai_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_status ON ai_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_pinned ON ai_sessions(pinned, updated_at DESC);

-- AI messages (tree structure with parent_id for branching)
CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  raw_json TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  reasoning TEXT,
  token_count INTEGER,
  finish_reason TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_parent ON ai_messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_content ON ai_messages(content);

-- AI tool call audit logs
CREATE TABLE IF NOT EXISTS ai_tool_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT,
  tool_name TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  elapsed_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_logs_session ON ai_tool_logs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_logs_tool ON ai_tool_logs(tool_name);

-- AI skill registry
CREATE TABLE IF NOT EXISTS ai_skills (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_path TEXT,
  description TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  globs TEXT,
  always_apply INTEGER DEFAULT 0,
  frontmatter_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_skills_source ON ai_skills(source, enabled);

-- AI context compaction tracking
CREATE TABLE IF NOT EXISTS ai_context_compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  before_tokens INTEGER,
  after_tokens INTEGER,
  compacted_message_ids TEXT,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);
`;

/**
 * v10: sync_keyring — sync 模块的 masterKey 信封持久化表。
 *
 * 设计要点：
 * - 单行表（id=1）：整个进程共享一个 sync keyring 实例
 * - masterKey 由 setup() 随机生成，分别用密码和恢复码派生 wrapKey 后 AES-GCM 加密
 * - salt 同时用于密码派生与恢复码派生（不同用途通过 info 字符串区分，或共用同一 scrypt 盐）
 * - recovery_code_hash 用于在 unlockWithRecovery 时快速校验恢复码是否正确
 * - version 字段支持未来协议升级（如更换 KDF 算法）
 */
const SYNC_KEYRING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_keyring (
  id INTEGER PRIMARY KEY DEFAULT 1,
  salt TEXT NOT NULL,
  wrapped_master_by_password TEXT NOT NULL,
  wrapped_master_by_recovery TEXT NOT NULL,
  recovery_code_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * v11: RAG 向量块存储 — T10 RAG 模块。
 * embedding 存为 BLOB（Float32Array 的 Buffer），查询时全量扫描计算余弦相似度。
 */
const RAG_CHUNKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rag_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_project ON rag_chunks(project_id, file_path);
`;

/**
 * v12: 插件持久化 — T11 插件沙箱 + API 路由。
 * 存储 enable/disable 状态、配置 JSON、安装来源、版本兼容信息。
 */
const PLUGINS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  source TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Migrate old ai_chat_sessions (JSON blob) into new ai_sessions + ai_messages tables.
 * Only runs if the old table exists and has data that hasn't been migrated yet.
 * The old table is preserved as backup (not dropped).
 */
function migrateOldAiChatSessions(db: DatabaseCompat): void {
  // Check if old table exists
  const oldTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
    .get();
  if (!oldTable) return;

  // Pre-fetch valid project ids so we don't violate the ai_sessions FK
  // constraint (project_id REFERENCES projects(id)). Old sessions may
  // reference projects that were deleted.
  const validProjectIds = new Set(
    (db.prepare('SELECT id FROM projects').all() as Array<{ id: number }>).map((r) => r.id),
  );

  // Disable FK enforcement for the duration of the migration. Some legacy
  // rows may reference projects/sessions that no longer exist; we sanitize
  // what we can (project_id) but the messages chain is reconstructed
  // fresh, so the only remaining FK is session_id → ai_sessions which we
  // always satisfy. Disabling here is belt-and-suspenders to avoid a
  // single bad row aborting the whole migration.
  try {
    db.prepare('PRAGMA foreign_keys = OFF').run();
  } catch {
    /* ignore */
  }

  const oldSessions = db
    .prepare('SELECT session_id, project_id, messages, updated_at FROM ai_chat_sessions')
    .all() as Array<{
    session_id: string;
    project_id: number | null;
    messages: string;
    updated_at: string;
  }>;

  for (const old of oldSessions) {
    // Skip if already migrated (session exists in new table)
    const existing = db.prepare('SELECT id FROM ai_sessions WHERE id = ?').get(old.session_id);
    if (existing) continue;

    let messages: Array<{
      role?: string;
      content?: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }>;
    try {
      messages = JSON.parse(old.messages);
    } catch {
      continue;
    }
    if (!Array.isArray(messages) || messages.length === 0) continue;

    // Null out project_id if it references a deleted project (FK safety)
    const safeProjectId =
      old.project_id != null && validProjectIds.has(old.project_id) ? old.project_id : null;

    // Create new session
    db.prepare(
      `INSERT OR IGNORE INTO ai_sessions (id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, 'archived', ?, ?)`,
    ).run(
      old.session_id,
      safeProjectId,
      messages.find((m) => m.role === 'user')?.content?.slice(0, 50) || 'Migrated Session',
      old.updated_at,
      old.updated_at,
    );

    // Insert messages as flat chain (parent_id linked list)
    let parentId: string | null = null;
    for (const msg of messages) {
      const msgId = generateId();
      const role = msg.role || 'user';
      const content = msg.content || '';
      const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null;
      const toolCallId = msg.tool_call_id || null;

      db.prepare(
        `INSERT INTO ai_messages (id, session_id, parent_id, role, content, raw_json, tool_calls, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        msgId,
        old.session_id,
        parentId,
        role,
        content,
        JSON.stringify(msg),
        toolCalls,
        toolCallId,
      );
      parentId = msgId;
    }

    // Set current_leaf_id to last message
    if (parentId) {
      db.prepare('UPDATE ai_sessions SET current_leaf_id = ? WHERE id = ?').run(
        parentId,
        old.session_id,
      );
    }
    // Update message count
    db.prepare('UPDATE ai_sessions SET message_count = ? WHERE id = ?').run(
      messages.length,
      old.session_id,
    );
  }

  // Re-enable FK enforcement (was disabled at the top of this function).
  try {
    db.prepare('PRAGMA foreign_keys = ON').run();
  } catch {
    /* ignore */
  }
}

/** Simple UUID v4 generator (no external dependency) */
function generateId(): string {
  // Use crypto.randomUUID if available (Node 16+), otherwise fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
