/**
 * End-to-end encryption for sync — AES-256-GCM.
 */
import * as crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

export interface EncryptedPayload {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;       // Base64
  tag: string;      // Base64
  ciphertext: string; // Base64
}

export interface EncryptedFile extends EncryptedPayload {
  encryptedKey: string; // Base64 — fileKey encrypted with masterKey
  originalSize: number;
}

/**
 * Derive a master key from password using scrypt.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
}

/**
 * Generate a random salt for key derivation.
 */
export function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_LENGTH);
}

/**
 * Encrypt data with AES-256-GCM using a given key.
 */
export function encrypt(data: Buffer, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypt data with AES-256-GCM.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): Buffer {
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a file: generate random fileKey, encrypt content, wrap fileKey with masterKey.
 */
export function encryptFile(content: Buffer, masterKey: Buffer): EncryptedFile {
  const fileKey = crypto.randomBytes(KEY_LENGTH);
  const encrypted = encrypt(content, fileKey);
  const wrappedKey = encrypt(fileKey, masterKey);

  return {
    ...encrypted,
    encryptedKey: Buffer.from(JSON.stringify(wrappedKey)).toString('base64'),
    originalSize: content.length,
  };
}

/**
 * Decrypt a file: unwrap fileKey with masterKey, then decrypt content.
 */
export function decryptFile(file: EncryptedFile, masterKey: Buffer): Buffer {
  const wrappedKey: EncryptedPayload = JSON.parse(Buffer.from(file.encryptedKey, 'base64').toString());
  const fileKey = decrypt(wrappedKey, masterKey);
  return decrypt(file, fileKey);
}

/**
 * Generate a recovery code (24 hex chars = 96 bits).
 */
export function generateRecoveryCode(): string {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Hash a recovery code for storage (SHA-256).
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}
