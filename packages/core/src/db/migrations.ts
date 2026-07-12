import { getConnection, type DatabaseCompat } from './connection.js';

/**
 * Helper: add a column only if it doesn't already exist.
 * SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
 * so we catch the "duplicate column name" error.
 */
function addColumnIfNotExists(db: DatabaseCompat, table: string, column: string, definition: string): void {
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
}

const SCHEMA_SQL = `
-- 项目表
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_opened DATETIME
);

-- 配置表
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
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

-- 收藏表
CREATE TABLE IF NOT EXISTS favorites (
    project_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id),
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
