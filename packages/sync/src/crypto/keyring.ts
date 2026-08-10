/**
 * Keyring — sync 模块的 masterKey 信封管理器。
 *
 * 协议设计（参考 core/server/auth.ts 的 DEK 信封模式）：
 * 1. masterKey 在 setup() 时随机生成（crypto.randomBytes(32)），不再由密码直接派生
 *    —— 避免密码与恢复码派生出不同密钥导致恢复码无法解密的设计缺陷
 * 2. 密码与恢复码各自派生 wrapKey，分别 AES-GCM 加密同一个 masterKey
 *    —— 密码解锁与恢复码解锁共享同一 masterKey
 * 3. salt + wrappedMasterByPassword + wrappedMasterByRecovery + recoveryCodeHash 持久化到 DB
 *    —— 进程重启后可从 DB 恢复，无需调用方传递 salt
 *
 * 数据存储位置：core 包的 sync_keyring 表（v10 迁移）。
 * 单行表（id=1），整个进程共享一个 keyring 实例。
 */
import * as crypto from 'node:crypto';
import {
  deriveKey,
  generateSalt,
  generateRecoveryCode,
  hashRecoveryCode,
  encrypt,
  decrypt,
  type EncryptedPayload,
} from './encrypt.js';

// 从 @doc77/core 拿 DB 句柄。core 已在 index.ts 中导出 getConnection。
// sync 包的 tsup.config.ts 把 @doc77/core 设为 external，运行时由 monorepo 解析。
import type { DatabaseCompat } from '@doc77/core';
import { getConnection } from '@doc77/core';

/** keyring 协议版本号，写入 DB 以支持未来迁移 */
const KEYRING_VERSION = 1;

/** sync_keyring 表中的单行主键 */
const KEYRING_ROW_ID = 1;

export interface KeyringState {
  /** 是否已 unlock（masterKey 在内存中） */
  unlocked: boolean;
  /** 是否已 setup（DB 中有 keyring 记录） */
  hasEncryption: boolean;
}

/** 从 DB 读取的持久化字段（除 masterKey 外，masterKey 永远不持久化明文） */
interface PersistedKeyringRow {
  salt: string; // Base64
  wrapped_master_by_password: string; // JSON.stringify(EncryptedPayload) 的 Base64
  wrapped_master_by_recovery: string;
  recovery_code_hash: string;
  version: number;
}

/**
 * 安全尝试获取 DB 句柄。DB 未初始化时返回 null（keyring 退化为内存态）。
 * 这允许 keyring 在无 DB 环境（如单元测试不调用 initDatabase）也能基本工作，
 * 但持久化与跨进程恢复能力仅在 DB 可用时生效。
 */
function tryGetDb(): DatabaseCompat | null {
  try {
    return getConnection();
  } catch {
    return null;
  }
}

/**
 * 内联辅助：把 EncryptedPayload JSON 序列化后 Base64 编码，
 * 以便存入 DB 的 TEXT 字段。读取时反向解码。
 */
function encodeWrapped(payload: EncryptedPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
function decodeWrapped(b64: string): EncryptedPayload {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as EncryptedPayload;
}

export class Keyring {
  /** 内存中的 masterKey（unlock 后填充，lock 后清零） */
  private masterKey: Buffer | null = null;

  /** setup 时生成 / DB 加载得到的 salt（Base64 形式持久化） */
  private saltBase64: string | null = null;

  /** 恢复码的 SHA-256 哈希（用于 unlockWithRecovery 时校验） */
  private recoveryCodeHash: string | null = null;

  /** 密码包裹后的 masterKey（Base64 包装 EncryptedPayload） */
  private wrappedMasterByPassword: string | null = null;

  /** 恢复码包裹后的 masterKey */
  private wrappedMasterByRecovery: string | null = null;

  /** 协议版本号 */
  private readonly version: number = KEYRING_VERSION;

  /**
   * 启动时从 DB 加载已持久化的 keyring 元数据（不含 masterKey）。
   * 加载后实例处于 "已配置但锁定" 状态，等待 unlock() / unlockWithRecovery()。
   *
   * @returns true 表示 DB 中有 keyring 记录并已加载；false 表示尚未 setup 或 DB 不可用
   */
  loadFromDB(): boolean {
    const db = tryGetDb();
    if (!db) return false;
    try {
      const row = db
        .prepare(
          'SELECT salt, wrapped_master_by_password, wrapped_master_by_recovery, recovery_code_hash, version FROM sync_keyring WHERE id = ?',
        )
        .get(KEYRING_ROW_ID) as PersistedKeyringRow | undefined;
      if (!row) return false;
      this.saltBase64 = row.salt;
      this.wrappedMasterByPassword = row.wrapped_master_by_password;
      this.wrappedMasterByRecovery = row.wrapped_master_by_recovery;
      this.recoveryCodeHash = row.recovery_code_hash;
      return true;
    } catch {
      // sync_keyring 表未创建（migrations 未运行）等场景，降级为内存态
      return false;
    }
  }

  /**
   * 初始化加密：生成随机 masterKey，分别用密码和恢复码包裹同一 masterKey，
   * 并将所有元数据（不含 masterKey 明文）持久化到 DB。
   *
   * 若已 setup（DB 中已有记录或内存中已配置），返回 null 表示拒绝重复初始化。
   *
   * @returns 恢复码（仅在 setup 时一次性返回，调用方必须妥善保存）
   */
  setup(password: string): { recoveryCode: string } | null {
    // 已 setup 检查：优先看 DB，再看内存态
    if (this.isConfigured()) return null;

    const salt = generateSalt();
    this.saltBase64 = salt.toString('base64');

    // 关键修复 1：masterKey 随机生成，不再由密码派生
    const masterKey = crypto.randomBytes(32);
    this.masterKey = masterKey;

    // 关键修复 2：密码派生 wrapKey，AES-GCM 加密同一 masterKey
    const pwWrapKey = deriveKey(password, salt);
    const wrappedByPw = encrypt(masterKey, pwWrapKey);
    this.wrappedMasterByPassword = encodeWrapped(wrappedByPw);

    // 关键修复 3：恢复码派生 wrapKey，加密同一个 masterKey
    const recoveryCode = generateRecoveryCode();
    this.recoveryCodeHash = hashRecoveryCode(recoveryCode);
    const rcWrapKey = deriveKey(recoveryCode, salt);
    const wrappedByRc = encrypt(masterKey, rcWrapKey);
    this.wrappedMasterByRecovery = encodeWrapped(wrappedByRc);

    // 持久化到 DB（若可用）。失败时不抛错，但 setup 仍视为成功（内存态可用）
    this.saveToDB();

    return { recoveryCode };
  }

  /**
   * 用密码解锁：从 DB（或内存中已加载的）salt + wrappedMasterByPassword 派生 wrapKey，
   * AES-GCM 解出 masterKey。
   *
   * @returns true 解锁成功；false 表示尚未 setup（无记录）
   * @throws 解密失败（密码错误导致 GCM tag 校验失败）时抛错，调用方应捕获
   */
  unlock(password: string): boolean {
    if (!this.ensureLoaded()) return false;
    if (!this.saltBase64 || !this.wrappedMasterByPassword) return false;

    const salt = Buffer.from(this.saltBase64, 'base64');
    const pwWrapKey = deriveKey(password, salt);
    const wrapped = decodeWrapped(this.wrappedMasterByPassword);
    // GCM tag 校验失败会抛错（密码错误）—— 调用方应 try/catch
    this.masterKey = decrypt(wrapped, pwWrapKey);
    return true;
  }

  /**
   * 用恢复码解锁：校验 recoveryCodeHash，通过后派生 rcWrapKey 解出 masterKey。
   *
   * @returns true 解锁成功；false 表示恢复码不匹配或尚未 setup
   * @throws 解密失败时抛错
   */
  unlockWithRecovery(code: string): boolean {
    if (!this.ensureLoaded()) return false;
    if (!this.saltBase64 || !this.wrappedMasterByRecovery || !this.recoveryCodeHash) return false;

    // 先校验恢复码哈希，避免无谓的解密开销
    const hash = hashRecoveryCode(code);
    if (hash !== this.recoveryCodeHash) {
      return false;
    }

    const salt = Buffer.from(this.saltBase64, 'base64');
    const rcWrapKey = deriveKey(code.trim().toLowerCase(), salt);
    const wrapped = decodeWrapped(this.wrappedMasterByRecovery);
    this.masterKey = decrypt(wrapped, rcWrapKey);
    return true;
  }

  /**
   * Lock — 清空内存中的 masterKey（清零敏感数据）。
   * 不清除持久化元数据（salt/wrappedMaster 等），下次可重新 unlock。
   */
  lock(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
  }

  /**
   * 获取 masterKey（解锁后才能调用）。调用方应保证用完即 lock()，
   * 不要长期持有 masterKey 引用。
   */
  getKey(): Buffer {
    if (!this.masterKey) throw new Error('Keyring is locked');
    return this.masterKey;
  }

  getState(): KeyringState {
    return {
      unlocked: this.masterKey !== null,
      hasEncryption: this.saltBase64 !== null,
    };
  }

  /**
   * 是否已 setup。优先检查 DB，再检查内存态。
   */
  isConfigured(): boolean {
    const db = tryGetDb();
    if (db) {
      try {
        const row = db.prepare('SELECT id FROM sync_keyring WHERE id = ?').get(KEYRING_ROW_ID);
        if (row) return true;
      } catch {
        // 表未创建等，继续走内存态判断
      }
    }
    // 内存态：setup 后 saltBase64 与 wrappedMasterByPassword 都非空
    return !!(this.saltBase64 && this.wrappedMasterByPassword);
  }

  /**
   * 懒加载：若内存中无 salt 但 DB 有记录，则从 DB 加载。
   * 用于 unlock/unlockWithRecovery 在 getKeyring() 单例刚创建时的场景。
   */
  private ensureLoaded(): boolean {
    if (this.saltBase64) return true;
    return this.loadFromDB();
  }

  /**
   * 把当前 keyring 元数据持久化到 sync_keyring 表（INSERT OR REPLACE）。
   * 仅在 DB 可用时生效。masterKey 永远不持久化明文。
   */
  private saveToDB(): void {
    if (
      !this.saltBase64 ||
      !this.wrappedMasterByPassword ||
      !this.wrappedMasterByRecovery ||
      !this.recoveryCodeHash
    ) {
      return;
    }
    const db = tryGetDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT OR REPLACE INTO sync_keyring
          (id, salt, wrapped_master_by_password, wrapped_master_by_recovery, recovery_code_hash, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        KEYRING_ROW_ID,
        this.saltBase64,
        this.wrappedMasterByPassword,
        this.wrappedMasterByRecovery,
        this.recoveryCodeHash,
        this.version,
      );
    } catch {
      // 持久化失败不致命：内存态仍可用，但进程重启后状态会丢失
    }
  }
}

let _keyring: Keyring | null = null;

/**
 * 获取 keyring 单例。首次调用时尝试从 DB 加载已持久化的元数据，
 * 加载后处于 "已配置但锁定" 状态，等待 unlock() / unlockWithRecovery()。
 */
export function getKeyring(): Keyring {
  if (!_keyring) {
    _keyring = new Keyring();
    _keyring.loadFromDB();
  }
  return _keyring;
}

/**
 * 仅供测试使用：重置 keyring 单例，清空内存状态。
 * 生产代码不应调用此函数。
 */
export function __resetKeyringForTest(): void {
  _keyring = null;
}
