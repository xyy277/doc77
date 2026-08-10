/**
 * T9 验收测试 — 适配器 E2EE 集成
 *
 * 覆盖验收标准：
 * - keyring unlock → push 文件 → 远端存储的是加密格式（含 magic + ciphertext，非明文）
 * - pull 加密文件 → decryptFile → 内容与原始一致
 * - keyring locked → push 走明文（不崩溃）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initDatabase, closeConnection, runMigrations, getConnection } from '@doc77/core';
import {
  createSyncEngine,
  getKeyring,
  __resetKeyringForTest,
  encryptFile,
  decryptFile,
} from '../src/index.js';
import {
  maybeEncryptContent,
  maybeDecryptContent,
  isEncryptedContent,
} from '../src/crypto/e2ee-helper.js';
import type { Keyring } from '../src/crypto/keyring.js';

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-e2ee-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();
});

afterAll(() => {
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个测试前清空 sync_keyring 表 + 重置 keyring 单例
  try {
    getConnection().prepare('DELETE FROM sync_keyring WHERE id = 1').run();
  } catch {
    /* ignore */
  }
  __resetKeyringForTest();
});

describe('T9 — E2EE 辅助模块', () => {
  it('keyring unlock 时 maybeEncryptContent 返回加密格式（含 magic）', () => {
    const kr = new (getKeyring().constructor as new () => Keyring)();
    kr.setup('test-pass');
    const original = Buffer.from('hello e2ee world', 'utf-8');
    const encrypted = maybeEncryptContent(original, kr);
    expect(isEncryptedContent(encrypted)).toBe(true);
    expect(encrypted.equals(original)).toBe(false);
  });

  it('加密后 maybeDecryptContent 还原原始内容', () => {
    const kr = new (getKeyring().constructor as new () => Keyring)();
    kr.setup('test-pass');
    const original = Buffer.from('secret content for round-trip', 'utf-8');
    const encrypted = maybeEncryptContent(original, kr);
    const decrypted = maybeDecryptContent(encrypted, kr);
    expect(decrypted.equals(original)).toBe(true);
  });

  it('keyring null 时 maybeEncryptContent 返回明文（向后兼容）', () => {
    const original = Buffer.from('plaintext content', 'utf-8');
    const result = maybeEncryptContent(original, null);
    expect(result.equals(original)).toBe(true);
    expect(isEncryptedContent(result)).toBe(false);
  });

  it('keyring null 时 maybeDecryptContent 对明文返回原内容', () => {
    const original = Buffer.from('plaintext content', 'utf-8');
    const result = maybeDecryptContent(original, null);
    expect(result.equals(original)).toBe(true);
  });

  it('keyring locked 时 maybeEncryptContent 返回明文', () => {
    const kr = new (getKeyring().constructor as new () => Keyring)();
    kr.setup('test-pass');
    kr.lock();
    const original = Buffer.from('content while locked', 'utf-8');
    const result = maybeEncryptContent(original, kr);
    expect(result.equals(original)).toBe(true);
  });

  it('加密文件 + keyring locked 时 maybeDecryptContent 抛错', () => {
    const kr1 = new (getKeyring().constructor as new () => Keyring)();
    kr1.setup('test-pass');
    const original = Buffer.from('encrypted then locked', 'utf-8');
    const encrypted = maybeEncryptContent(original, kr1);

    const kr2 = new (getKeyring().constructor as new () => Keyring)();
    kr2.setup('other-pass');
    kr2.lock();
    expect(() => maybeDecryptContent(encrypted, kr2)).toThrow(/locked|decrypt/i);
  });
});

/**
 * T9 集成测试：通过 LocalAdapter push/pull 验证端到端 E2EE
 */
describe('T9 — LocalAdapter 端到端 E2EE', () => {
  it('keyring unlock → push → 远端存储加密格式 → pull → 内容还原', async () => {
    const projectPath = path.join(testDir, 'e2ee-project');
    const targetPath = path.join(testDir, 'e2ee-target');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(targetPath, { recursive: true });

    const secretContent = 'top secret document content';
    fs.writeFileSync(path.join(projectPath, 'secret.md'), secretContent);

    // setup keyring（用单例，LocalAdapter 内部也用 getKeyring() 单例）
    const singletonKr = getKeyring();
    singletonKr.setup('e2ee-pass-singleton');

    const engine = createSyncEngine();
    const config = {
      id: 1,
      project_id: 1,
      adapter_type: 'local',
      config_json: JSON.stringify({
        type: 'local',
        targetPath,
        mirror: false,
        ignorePatterns: [],
      }),
      direction: 'push' as const,
      interval_seconds: 0,
      enabled: 1,
    };

    const result = await engine.sync(1, projectPath, config);
    expect(result.status).toBe('success');
    expect(result.pushed).toBeGreaterThan(0);

    // 验证远端存储的是加密格式
    const storedData = fs.readFileSync(path.join(targetPath, 'secret.md'));
    expect(isEncryptedContent(storedData)).toBe(true);
    expect(storedData.toString('utf-8')).not.toContain(secretContent);

    // pull 回来验证解密
    fs.unlinkSync(path.join(projectPath, 'secret.md'));
    const pullConfig = { ...config, direction: 'pull' as const };
    const pullResult = await engine.sync(1, projectPath, pullConfig);
    expect(pullResult.pulled).toBeGreaterThan(0);

    const pulledContent = fs.readFileSync(path.join(projectPath, 'secret.md'), 'utf-8');
    expect(pulledContent).toBe(secretContent);

    // 清理单例 keyring 状态
    singletonKr.lock();
  });

  it('keyring 未 setup → push 走明文（向后兼容）', async () => {
    const projectPath = path.join(testDir, 'plain-project');
    const targetPath = path.join(testDir, 'plain-target');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(targetPath, { recursive: true });

    const plainContent = 'this is plaintext';
    fs.writeFileSync(path.join(projectPath, 'plain.txt'), plainContent);

    // 确保 keyring 单例未 unlock
    const kr = getKeyring();
    kr.lock();

    const engine = createSyncEngine();
    const config = {
      id: 2,
      project_id: 2,
      adapter_type: 'local',
      config_json: JSON.stringify({
        type: 'local',
        targetPath,
        mirror: false,
        ignorePatterns: [],
      }),
      direction: 'push' as const,
      interval_seconds: 0,
      enabled: 1,
    };

    const result = await engine.sync(2, projectPath, config);
    expect(result.status).toBe('success');
    expect(result.pushed).toBeGreaterThan(0);

    // 远端存储的是明文
    const storedData = fs.readFileSync(path.join(targetPath, 'plain.txt'), 'utf-8');
    expect(storedData).toBe(plainContent);
    expect(isEncryptedContent(Buffer.from(storedData, 'utf-8'))).toBe(false);
  });
});
