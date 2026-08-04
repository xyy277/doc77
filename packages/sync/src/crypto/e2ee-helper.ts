/**
 * E2EE 适配器辅助模块 — 为 webdav/s3/local 适配器提供统一的加密/解密封装。
 *
 * 设计要点：
 * 1. 加密文件格式：magic bytes `DOC77ENC1\n` + JSON.stringify(EncryptedFile)
 *    —— magic bytes 便于 pull 时快速检测是否为加密格式
 * 2. 向后兼容：keyring 未 setup 或未 unlock 时，push/pull 走明文（当前行为）
 * 3. git 适配器不使用此模块（git 有自己的传输加密，应用层加密会破坏 git diff）
 */
import { encryptFile, decryptFile, type EncryptedFile } from './encrypt.js';
import type { Keyring } from './keyring.js';

/** 加密文件的 magic 前缀（pull 时据此检测） */
const E2EE_MAGIC = 'DOC77ENC1\n';

/**
 * 尝试加密文件内容。
 * - keyring 为 null / 未 unlock / 未 setup → 返回原始 Buffer（明文）
 * - keyring 已 unlock → 返回加密格式 Buffer（magic + JSON）
 */
export function maybeEncryptContent(content: Buffer, keyring: Keyring | null): Buffer {
  if (!keyring) return content;
  const state = keyring.getState();
  if (!state.unlocked) return content;

  try {
    const encrypted = encryptFile(content, keyring.getKey());
    // 序列化：magic + JSON
    const json = JSON.stringify(encrypted);
    return Buffer.concat([Buffer.from(E2EE_MAGIC, 'utf-8'), Buffer.from(json, 'utf-8')]);
  } catch (e) {
    console.error('[e2ee] encrypt failed, falling back to plaintext:', e);
    return content;
  }
}

/**
 * 尝试解密文件内容。
 * - 检测 magic 前缀，若不匹配 → 返回原始 Buffer（明文）
 * - 若匹配但 keyring 未 unlock → 抛错（无法解密）
 * - 若匹配且 keyring 已 unlock → 返回解密后的原始 Buffer
 */
export function maybeDecryptContent(data: Buffer, keyring: Keyring | null): Buffer {
  // 快速检测：不以 magic 开头则视为明文
  const magicBuf = Buffer.from(E2EE_MAGIC, 'utf-8');
  if (data.length < magicBuf.length) return data;
  if (!data.subarray(0, magicBuf.length).equals(magicBuf)) return data;

  // 是加密文件
  if (!keyring || !keyring.getState().unlocked) {
    throw new Error('Encrypted file detected but keyring is locked — cannot decrypt');
  }

  const json = data.subarray(magicBuf.length).toString('utf-8');
  const encrypted = JSON.parse(json) as EncryptedFile;
  return decryptFile(encrypted, keyring.getKey());
}

/** 检测 Buffer 是否为加密格式（有 magic 前缀） */
export function isEncryptedContent(data: Buffer): boolean {
  const magicBuf = Buffer.from(E2EE_MAGIC, 'utf-8');
  if (data.length < magicBuf.length) return false;
  return data.subarray(0, magicBuf.length).equals(magicBuf);
}
