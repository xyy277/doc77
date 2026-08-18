import { getConnection } from './connection.js';
import { readConfigValue, writeConfigValue } from './config-crypto.js';
import { isSensitiveKey, maskSensitive } from '../crypto.js';

/**
 * Default configuration values defined in architecture doc §7.3.
 */
const DEFAULTS: Record<string, string> = {
  'ai.provider': 'custom',
  'ai.enabled': 'false',
  'ai.auto_mode': 'false',
  'ai.risk_level': 'medium',
  'ai.confirm_delete': 'true',
  'ai.batch_size': '5',
  'ai.require_approval_types': '["delete_file"]',
  'ai.max_depth': '5',
  'ai.read_limit_per_session': '200',
  'editor.default': 'vscode',
  'editor.maxFileSizeMB': '2',
  'editor.autoSave': 'true',
  'security.follow_symlinks': 'false',
  'security.lan_restrict': 'true',
  'transaction.shadow_dir': '~/.doc77/shadow',
  'transaction.file_size_threshold_mb': '50',
  'transaction.rollback_enabled': 'true',
  'transaction.shadow_gc_enabled': 'true',
  'transaction.shadow_orphan_age_hours': '24',
  'concurrency.enable_project_lock': 'true',
  'concurrency.lock_timeout_minutes': '10',
  'concurrency.lock_heartbeat_seconds': '30',
  'security.bind_address': '127.0.0.1',
  'server.port': '27777',
  'security.shared_secret': '',
  'session.idle_timeout_minutes': '120',
  'session.cleanup_interval_minutes': '60',
  'rate.write_limit_per_session': '50',
  'rate.write_window_minutes': '5',
  'transport.mcp_stdio_enabled': 'true',
  'transport.mcp_http_enabled': 'true',
  'transport.mcp_http_port': '8899',
  'translate.enabled': 'true',
  'translate.mirror': 'false',
  'translate.default_source': 'auto',
  'translate.default_target': 'zh',
  'translate.max_segment_length': '500',
  'locale.language': '', // empty = auto-detect (system LANG / browser Accept-Language)
  'export.html.maxFileSizeMB': '10',
  'export.share.ttl_hours': '24',
  'export.share.enabled': 'true',
  'share.host_override': '',
  // 隧道安全策略：'open'（默认，配合认证门控）/ 'readonly'（禁止写操作）/ 'password'
  'tunnel.access_policy': 'open',
};

/**
 * Get a config value by key (sensitive keys are decrypted transparently).
 * Returns the raw string value, or undefined if not set.
 */
export function getConfig(key: string): string | undefined {
  return readConfigValue(key);
}

/**
 * Set a config value. Inserts or updates as needed.
 * Sensitive keys (token/secret/password/...) are encrypted at rest via
 * the machine key file (config.key) — see config-crypto.ts.
 */
export function setConfig(key: string, value: string): void {
  writeConfigValue(key, value);
}

/**
 * List all config entries as a key-value object.
 * Sensitive keys are decrypted then masked (••••) — never expose plaintext
 * secrets through bulk listing (CLI `config list` / settings panel).
 */
export function listConfig(): Record<string, string> {
  const db = getConnection();
  const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all() as {
    key: string;
    value: string;
  }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = isSensitiveKey(row.key)
      ? maskSensitive(readConfigValue(row.key) ?? '')
      : row.value;
  }
  return result;
}

/**
 * Load default config values.
 * Only inserts entries for keys that don't already exist (idempotent).
 */
export function loadDefaults(): void {
  const db = getConnection();
  const insert = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');

  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      insert.run(key, value);
    }
  });

  tx();
}
