/**
 * T2 验收测试 — Keyring 协议重设计（DEK 信封模式）
 *
 * 覆盖验收标准：
 * 1. setup('pass') → encryptFile(data) → lock() → unlockWithRecovery(code) → decryptFile() 成功
 * 2. 错误恢复码返回 false 且不修改内部状态
 * 3. 进程重启（重新 getKeyring()）后从 DB 恢复 salt + wrappedMaster
 *
 * 测试范式参考 packages/core/__tests__/auth.test.ts：
 * - 用临时目录 + sql.js 初始化真实 DB（in-memory 模式持久化到 tmp 文件）
 * - 调用 runMigrations() 创建 sync_keyring 表
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initDatabase, closeConnection, runMigrations, getConnection } from '@doc77/core';
import { Keyring, getKeyring } from '../src/crypto/keyring.js';
import { encryptFile, decryptFile } from '../src/crypto/encrypt.js';

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  testDir = path.join(
    os.tmpdir(),
    `doc77-sync-keyring-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();
});

afterAll(() => {
  try {
    closeConnection();
  } catch {
    // ignore
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

/**
 * 每个测试前清空 sync_keyring 表，确保 setup() 不会因为 DB 已有记录而返回 null。
 * 多个测试共享同一 DB 连接，但 keyring 状态独立。
 */
beforeEach(() => {
  try {
    getConnection().prepare('DELETE FROM sync_keyring WHERE id = 1').run();
  } catch {
    // 表不存在等场景，忽略
  }
});

/**
 * 用工厂创建新的 Keyring 实例（绕过 getKeyring 单例）。
 * 用于测试"进程重启"场景：模拟新进程重新构造 keyring 并从 DB 加载。
 */
function createFreshKeyring(): Keyring {
  return new Keyring();
}

describe('Keyring — DEK 信封协议', () => {
  it('setup 生成恢复码并持久化到 DB', () => {
    const kr = createFreshKeyring();
    const result = kr.setup('my-password');
    expect(result).not.toBeNull();
    expect(result!.recoveryCode).toMatch(/^[0-9a-f]{24}$/); // 24 hex chars
    expect(kr.getState().unlocked).toBe(true);
    expect(kr.getState().hasEncryption).toBe(true);
  });

  it('拒绝重复 setup（已配置）', () => {
    const kr = createFreshKeyring();
    kr.setup('pass1');
    const second = kr.setup('pass2');
    expect(second).toBeNull();
  });

  it('完整流程：setup → encryptFile → lock → unlockWithRecovery → decryptFile 成功', () => {
    // 用独立实例避免与其他测试状态污染
    const kr = createFreshKeyring();
    const { recoveryCode } = kr.setup('pass-complete-flow')!;

    // 用 setup 后的 masterKey 加密文件
    const originalContent = Buffer.from('hello doc77 e2ee sync content', 'utf8');
    const encrypted = encryptFile(originalContent, kr.getKey());

    // lock 清除内存中的 masterKey
    kr.lock();
    expect(kr.getState().unlocked).toBe(false);
    expect(() => kr.getKey()).toThrowError(/locked/);

    // 用恢复码解锁 —— 关键修复点：同一 masterKey 必须能解密
    const ok = kr.unlockWithRecovery(recoveryCode);
    expect(ok).toBe(true);
    expect(kr.getState().unlocked).toBe(true);

    // 解密文件，内容必须与原内容一致
    const decrypted = decryptFile(encrypted, kr.getKey());
    expect(decrypted.equals(originalContent)).toBe(true);
  });

  it('完整流程：setup → encryptFile → lock → unlock(password) → decryptFile 成功', () => {
    const kr = createFreshKeyring();
    kr.setup('pass-unlock-flow');

    const originalContent = Buffer.from('content encrypted by password unlock path', 'utf8');
    const encrypted = encryptFile(originalContent, kr.getKey());

    kr.lock();
    expect(kr.getState().unlocked).toBe(false);

    const ok = kr.unlock('pass-unlock-flow');
    expect(ok).toBe(true);

    const decrypted = decryptFile(encrypted, kr.getKey());
    expect(decrypted.equals(originalContent)).toBe(true);
  });

  it('错误恢复码返回 false 且不修改内部状态（仍处于 locked）', () => {
    const kr = createFreshKeyring();
    kr.setup('pass-wrong-rc');

    // lock 后尝试用错误恢复码解锁
    kr.lock();
    expect(kr.getState().unlocked).toBe(false);

    const wrongCode = '0'.repeat(24); // 24 hex chars 但内容错误
    const ok = kr.unlockWithRecovery(wrongCode);
    expect(ok).toBe(false);

    // 关键断言：错误恢复码不应改变 locked 状态
    expect(kr.getState().unlocked).toBe(false);
    expect(() => kr.getKey()).toThrowError(/locked/);
  });

  it('错误密码抛错（GCM tag 校验失败），masterKey 仍未填充', () => {
    const kr = createFreshKeyring();
    kr.setup('correct-password');

    kr.lock();
    // GCM tag 校验失败会抛错
    expect(() => kr.unlock('wrong-password')).toThrow();
    expect(kr.getState().unlocked).toBe(false);
    expect(() => kr.getKey()).toThrowError(/locked/);
  });

  it('进程重启场景：新实例从 DB 恢复 salt + wrappedMaster 后可用密码解锁', () => {
    // 第一个"进程"setup
    const kr1 = createFreshKeyring();
    const { recoveryCode } = kr1.setup('restart-password')!;
    kr1.lock();

    // 模拟进程重启：构造新实例，从 DB 加载持久化状态
    const kr2 = createFreshKeyring();
    const loaded = kr2.loadFromDB();
    expect(loaded).toBe(true);
    // 加载后处于"已配置但锁定"状态
    expect(kr2.getState().unlocked).toBe(false);
    expect(kr2.getState().hasEncryption).toBe(true);

    // 用密码解锁
    const ok = kr2.unlock('restart-password');
    expect(ok).toBe(true);
    expect(kr2.getState().unlocked).toBe(true);

    // 用恢复码也应能解锁
    kr2.lock();
    const okRc = kr2.unlockWithRecovery(recoveryCode);
    expect(okRc).toBe(true);
  });

  it('isConfigured：setup 前为 false，setup 后为 true（含 DB 持久化）', () => {
    // beforeEach 已清空 sync_keyring 表，新实例内存态也空，isConfigured 应为 false
    const kr = createFreshKeyring();
    expect(kr.isConfigured()).toBe(false);

    // setup 后内存态 + DB 都有记录，isConfigured 应为 true
    kr.setup('cfg-flag-check');
    expect(kr.isConfigured()).toBe(true);

    // 新实例不调用 loadFromDB 也应通过 DB 检测识别为已配置
    const kr2 = createFreshKeyring();
    expect(kr2.isConfigured()).toBe(true);
  });

  it('lock 后再次 lock 幂等（不抛错）', () => {
    const kr = createFreshKeyring();
    kr.setup('lock-idempotent');
    kr.lock();
    expect(() => kr.lock()).not.toThrow();
    expect(kr.getState().unlocked).toBe(false);
  });
});
