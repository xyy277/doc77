import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { getConfig, setConfig } from '../src/db/config.js';
import {
  getConfigKeyPath,
  getOrCreateConfigKey,
  readConfigValue,
  writeConfigValue,
  migrateSensitiveConfigs,
} from '../src/db/config-crypto.js';
import * as crypto from '../src/crypto.js';

/**
 * v1.1.9 安全修复：config 敏感值（ai.token 等）统一加密存储。
 *
 * 背景：CLI `doc77 config set` 与设置页保存都曾绕过加密（CLI 的 setConfig
 * 裸写；设置页加密分支依赖 user_auth.pbkdf2_salt，DEK 迁移后该字段被清空
 * → 加密分支失效 → 明文落库）。本模块引入机器密钥文件 config.key
 * （与 DB 同目录、权限 0600），server 与 CLI 共用，敏感 key 一律
 * AES-256-GCM 加密存储，读取时兼容历史明文与旧 pbkdf2 派生 key 密文。
 */
describe('Config sensitive value encryption', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `doc77-config-crypto-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function rawValue(key: string): string | undefined {
    const row = getConnection().prepare('SELECT value FROM config WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  it('writeConfigValue: 敏感 key 加密落库，读回明文（roundtrip）', () => {
    writeConfigValue('ai.token', 'sk-test-token-123456');
    const stored = rawValue('ai.token');
    expect(stored).not.toContain('sk-test-token-123456');
    expect(stored).toMatch(/^\{"iv":"[0-9a-f]+","tag":"[0-9a-f]+","ciphertext":"[0-9a-f]+"\}$/);
    expect(readConfigValue('ai.token')).toBe('sk-test-token-123456');
  });

  it('writeConfigValue: 非敏感 key 原样存储', () => {
    writeConfigValue('locale.language', 'zh');
    expect(rawValue('locale.language')).toBe('zh');
  });

  it('readConfigValue: 历史明文直接返回（兼容，不炸）', () => {
    getConnection()
      .prepare('INSERT INTO config (key, value) VALUES (?, ?)')
      .run('ai.token', 'sk-plaintext-legacy');
    expect(readConfigValue('ai.token')).toBe('sk-plaintext-legacy');
  });

  it('readConfigValue: 旧 pbkdf2 派生 key 密文可解密（兼容旧加密）', () => {
    // 旧体系加密发生在用户设置密码时，user_auth.pbkdf2_salt 存在（DEK
    // 迁移前）。此处模拟该场景：建 user_auth 行 + 旧 key 加密值
    const salt = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef', 'hex');
    getConnection()
      .prepare('INSERT INTO user_auth (id, pbkdf2_salt) VALUES (1, ?)')
      .run(salt.toString('hex'));
    const enc = crypto.encrypt('sk-legacy-encrypted', crypto.deriveKey('doc77-config-key', salt));
    getConnection()
      .prepare('INSERT INTO config (key, value) VALUES (?, ?)')
      .run('ai.token', JSON.stringify(enc));
    expect(readConfigValue('ai.token')).toBe('sk-legacy-encrypted');
  });

  it('migrateSensitiveConfigs: 明文行迁移为密文，读回一致；重复执行幂等', () => {
    getConnection()
      .prepare('INSERT INTO config (key, value) VALUES (?, ?)')
      .run('ai.token', 'sk-needs-migration');
    getConnection()
      .prepare('INSERT INTO config (key, value) VALUES (?, ?)')
      .run('ai.base_url', 'https://api.example.com');

    const migrated = migrateSensitiveConfigs();
    expect(migrated).toBe(1); // 只有 ai.token 是敏感 key

    const stored = rawValue('ai.token');
    expect(stored).not.toContain('sk-needs-migration');
    expect(readConfigValue('ai.token')).toBe('sk-needs-migration');
    expect(rawValue('ai.base_url')).toBe('https://api.example.com');

    expect(migrateSensitiveConfigs()).toBe(0); // 幂等
  });

  it('setConfig/getConfig 集成：敏感 key 自动加密、普通 key 不受影响', () => {
    setConfig('ai.token', 'sk-setconfig-token');
    expect(rawValue('ai.token')).not.toContain('sk-setconfig-token');
    expect(getConfig('ai.token')).toBe('sk-setconfig-token');

    setConfig('ai.base_url', 'https://api.deepseek.com');
    expect(rawValue('ai.base_url')).toBe('https://api.deepseek.com');
    expect(getConfig('ai.base_url')).toBe('https://api.deepseek.com');
  });

  it('config.key 文件：与 DB 同目录创建，权限 0600', () => {
    const keyPath = getConfigKeyPath();
    expect(keyPath).toBe(path.join(testDir, 'config.key'));
    getOrCreateConfigKey();
    expect(fs.existsSync(keyPath)).toBe(true);
    // POSIX 权限位在 Windows 上无意义（chmod 为 no-op，mode 恒 0666），
    // 仅 POSIX 平台断言 0600；Windows 只验证存在性与 owner 可写
    if (process.platform !== 'win32') {
      const mode = fs.statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      expect(fs.statSync(keyPath).mode & 0o200).not.toBe(0);
    }
    // 密钥长度 32 字节（AES-256）
    expect(fs.readFileSync(keyPath).length).toBe(32);
    // 重复获取返回同一把钥匙（不重建）
    expect(getOrCreateConfigKey().equals(fs.readFileSync(keyPath))).toBe(true);
  });
});
