import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface EncryptedData {
  iv: string;
  tag: string;
  ciphertext: string;
}

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SCRYPT_KEY_LENGTH = 64;

export function generateSalt(length = 16): Buffer {
  return randomBytes(length);
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, 100_000, KEY_LENGTH, 'sha256');
}

export function encrypt(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', normalizeKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

export function decrypt(data: EncryptedData, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', normalizeKey(key), Buffer.from(data.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(data.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, saltHex, hashHex] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function checkPasswordStrength(password: string): {
  score: number;
  feedback: string[];
} {
  const feedback: string[] = [];
  let score = 0;

  if (password.length >= 8) score += 1;
  else feedback.push('密码至少需要 8 个字符');

  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  else feedback.push('建议同时包含大小写字母');

  if (/\d/.test(password)) score += 1;
  else feedback.push('建议包含数字');

  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  else feedback.push('建议包含特殊字符');

  return { score, feedback };
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return ['token', 'secret', 'password', 'apikey', 'api_key', 'authorization'].some((part) =>
    normalized.includes(part),
  );
}

export function maskSensitive(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function normalizeKey(key: Buffer): Buffer {
  if (key.length === KEY_LENGTH) return key;
  return Buffer.from(key.subarray(0, KEY_LENGTH));
}
