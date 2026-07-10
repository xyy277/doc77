import * as crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 600_000;
const SCRYPT_KEYLEN = 64;
const SALT_LENGTH = 32;

export interface EncryptedData {
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
}

/**
 * Encrypt plaintext with AES-256-GCM.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedData {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

/**
 * Decrypt AES-256-GCM ciphertext.
 */
export function decrypt(data: EncryptedData, key: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(data.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}

/**
 * Derive a 256-bit key from password + salt using PBKDF2-SHA512.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Generate a cryptographically random salt.
 */
export function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_LENGTH);
}

/**
 * Hash a password with scrypt for storage/verification.
 * Returns "salt$hash" as a single string.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}$${hash}`;
}

/**
 * Verify a password against a stored scrypt hash.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split('$');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
}

/**
 * Check password strength. Returns {score: 0-4, feedback: string}.
 */
export function checkPasswordStrength(password: string): {
  score: number;
  feedback: string;
} {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  const labels = ['非常弱', '弱', '一般', '强', '非常强'];
  return { score: Math.min(score, 4), feedback: labels[Math.min(score, 4)] };
}

/** Sensitive config keys whose values should be encrypted at rest. */
const SENSITIVE_KEYS = ['ai.token', 'security.shared_secret'];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.includes(key) || key.endsWith('.token') || key.endsWith('.secret');
}

/**
 * Mask a sensitive value for display (e.g., "sk-abc...xyz").
 */
export function maskSensitive(value: string): string {
  if (!value || value.length <= 8) return '••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}
