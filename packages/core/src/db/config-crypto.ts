import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getConnection, getDbPath } from './connection.js';
import { encrypt, decrypt, deriveKey, isSensitiveKey, type EncryptedData } from '../crypto.js';

/**
 * config 敏感值统一加密（v1.1.9 安全修复）。
 *
 * 背景：CLI `doc77 config set` 的 setConfig 裸写明文；设置页 /api/config
 * 的加密分支依赖 user_auth.pbkdf2_salt，而 DEK 迁移（auth.ts）后该字段被
 * 清空 → 加密分支失效 → 敏感值（ai.token 等）明文落库。auth.ts 的 DEK
 * 迁移只重加密"旧 key 密文"，明文行被跳过，历史明文永不被加密。
 *
 * 方案：机器密钥文件 `config.key`（与 data.db 同目录、权限 0600、
 * AES-256 随机密钥）——server 与 CLI 共用同一 HOME 即共用同一把钥匙，
 * 不依赖登录态/DEK（运行期无明文 DEK 可用）。敏感 key 一律 AES-256-GCM
 * 加密存储；读取兼容三级回退：机器密钥 → 旧 pbkdf2 派生 key（历史加密）
 * → 原样返回（历史明文 / DEK 密文兜底，与现状行为一致）。
 */

const KEY_BYTES = 32;

/** config.key 路径：与 DB 同目录（迁移/备份随 DB 一起走）。 */
export function getConfigKeyPath(): string {
  const dbPath = getDbPath();
  if (!dbPath) throw new Error('Database not initialized');
  return path.join(path.dirname(dbPath), 'config.key');
}

/** 读取或创建机器密钥（存在则读；损坏/长度不对则重建；权限 0600）。 */
export function getOrCreateConfigKey(): Buffer {
  const keyPath = getConfigKeyPath();
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === KEY_BYTES) return existing;
    // 长度不符 → 视为损坏，重建
  } catch {
    /* 不存在，生成 */
  }
  const key = randomBytes(KEY_BYTES);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* 权限设置尽力而为 */
  }
  return key;
}

/** 旧体系派生 key（DEK 迁移前用 pbkdf2_salt 派生 'doc77-config-key'）。 */
function legacyConfigKey(): Buffer | null {
  const row = getConnection().prepare('SELECT pbkdf2_salt FROM user_auth WHERE id = 1').get() as
    { pbkdf2_salt: string | null } | undefined;
  return row?.pbkdf2_salt
    ? deriveKey('doc77-config-key', Buffer.from(row.pbkdf2_salt, 'hex'))
    : null;
}

function tryDecryptWith(key: Buffer | null, stored: string): string | null {
  if (!key || !stored.startsWith('{')) return null;
  try {
    const data = JSON.parse(stored) as Partial<EncryptedData>;
    if (!data.iv || !data.tag || !data.ciphertext) return null;
    return decrypt(data as EncryptedData, key);
  } catch {
    return null;
  }
}

/**
 * 读取 config 值并解密（敏感 key）。
 * 回退顺序：机器密钥 → 旧 pbkdf2 派生 key → 原样返回（明文/解不开的兜底）。
 */
export function readConfigValue(key: string): string | undefined {
  const row = getConnection().prepare('SELECT value FROM config WHERE key = ?').get(key) as
    { value: string } | undefined;
  if (!row?.value) return undefined;
  if (!isSensitiveKey(key)) return row.value;
  return (
    tryDecryptWith(getOrCreateConfigKey(), row.value) ??
    tryDecryptWith(legacyConfigKey(), row.value) ??
    row.value
  );
}

/**
 * 写入 config 值（敏感 key 自动加密存储）。
 * 注意：仅当 DB 已初始化时加密（key 文件随 DB 目录）。调用方需保证
 * initDatabase 已执行。
 */
export function writeConfigValue(key: string, value: string): void {
  let stored = value;
  if (isSensitiveKey(key)) {
    stored = JSON.stringify(encrypt(value, getOrCreateConfigKey()));
  }
  getConnection()
    .prepare(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, stored);
}

/**
 * 启动迁移（幂等）：把历史明文 / 旧 key 密文的敏感 config 行统一加密为
 * 机器密钥。返回实际处理的行数。DEK 密文（两把 key 都解不开）跳过，
 * 读端回退原样返回，行为与现状一致。
 */
export function migrateSensitiveConfigs(): number {
  const db = getConnection();
  const rows = db.prepare('SELECT key, value FROM config').all() as {
    key: string;
    value: string;
  }[];
  const configKey = getOrCreateConfigKey();
  const legacyKey = legacyConfigKey();
  let count = 0;

  for (const row of rows) {
    if (!isSensitiveKey(row.key) || !row.value) continue;
    if (tryDecryptWith(configKey, row.value) !== null) continue; // 已是机器密钥密文
    const legacyPlain = tryDecryptWith(legacyKey, row.value);
    if (legacyPlain !== null) {
      db.prepare('UPDATE config SET value = ? WHERE key = ?').run(
        JSON.stringify(encrypt(legacyPlain, configKey)),
        row.key,
      );
      count++;
      continue;
    }
    if (!row.value.startsWith('{')) {
      // 历史明文 → 加密
      db.prepare('UPDATE config SET value = ? WHERE key = ?').run(
        JSON.stringify(encrypt(row.value, configKey)),
        row.key,
      );
      count++;
    }
  }
  return count;
}
