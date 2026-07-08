import { getConnection, type DatabaseCompat } from './connection.js';

/**
 * Run all schema migrations.
 * Uses IF NOT EXISTS to ensure idempotency.
 */
export function runMigrations(db?: DatabaseCompat): void {
  const conn = db ?? getConnection();
  conn.exec(SCHEMA_SQL);
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
`;
