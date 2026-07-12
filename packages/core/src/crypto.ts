import { createCipheriv, createDecipheriv, createHash, hkdfSync, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { scryptSync } from 'node:crypto';
export { scryptSync };

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

export function extractSalt(storedHash: string): Buffer {
  const parts = storedHash.split(':');
  if (parts.length !== 3) throw new Error('Invalid hash format');
  return Buffer.from(parts[1], 'hex');
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

// ---------------------------------------------------------------------------
// HKDF (HMAC-based Key Derivation Function) using Node.js crypto.hkdfSync
// ---------------------------------------------------------------------------

export function hkdf(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * Derive a password-based wrap key for DEK envelope encryption.
 * Uses scrypt + HKDF with the domain separator 'doc77-pw-wrap'.
 */
export function derivePasswordWrapKey(password: string, pwSalt: Buffer, pwWrapSalt: Buffer): Buffer {
  const scryptOutput = scryptSync(password, pwSalt, 64);
  return hkdf(scryptOutput, pwWrapSalt, 'doc77-pw-wrap', 32);
}

// ---------------------------------------------------------------------------
// Crockford Base32 encoding/decoding (RFC 4648 variant, no I/L/O/U)
// ---------------------------------------------------------------------------

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeBase32Crockford(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32Crockford(encoded: string): Buffer {
  const normalized = encoded.toUpperCase().replace(/-/g, '');
  const result: number[] = [];
  let bits = 0;
  let value = 0;

  for (let i = 0; i < normalized.length; i++) {
    const idx = CROCKFORD_ALPHABET.indexOf(normalized[i]);
    if (idx === -1) {
      throw new Error(`Invalid Crockford Base32 character: ${normalized[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      result.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(result);
}

// ---------------------------------------------------------------------------
// CRC-16 (CCITT-1021) returning a 5-bit checksum for Base32
// ---------------------------------------------------------------------------

export function crc16Base32(encoded: string): number {
  let crc = 0xFFFF;
  for (let i = 0; i < encoded.length; i++) {
    crc ^= encoded.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
  }
  return (crc & 0xFFFF) % 32; // map to 0-31 for Base32 digit
}

// ---------------------------------------------------------------------------
// DEK (Data Encryption Key) envelope — wrap/unwrap a random DEK with a key
// ---------------------------------------------------------------------------

export function generateDEK(): Buffer {
  return randomBytes(32);
}

export function wrapDEK(dek: Buffer, key: Buffer): EncryptedData {
  return encrypt(dek.toString('hex'), key);
}

export function unwrapDEK(data: EncryptedData, key: Buffer): Buffer {
  const hex = decrypt(data, key);
  return Buffer.from(hex, 'hex');
}

// ---------------------------------------------------------------------------
// Recovery Code generation — Crockford Base32 with CRC-16 checksum
// ---------------------------------------------------------------------------

export interface RecoveryCodeSet {
  plaintexts: string[];   // 25-char raw Base32 (24 data + 1 checksum)
  formatted: string[];    // 7-group dashed format
}

export function generateRecoveryCodes(count: number): RecoveryCodeSet {
  const plaintexts: string[] = [];
  const formatted: string[] = [];

  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(15); // 120 bits entropy -> 24 Base32 chars
    const encoded = encodeBase32Crockford(bytes); // 24 chars
    const checksum = crc16Base32(encoded);
    const checksumChar = CROCKFORD_ALPHABET[checksum];
    const withChecksum = encoded + checksumChar; // 25 chars

    plaintexts.push(withChecksum);

    // 25 chars -> pad to 28 for 7 groups of 4
    const padded = withChecksum.padEnd(28, '0');
    const groups: string[] = [];
    for (let g = 0; g < 7; g++) {
      groups.push(padded.slice(g * 4, (g + 1) * 4));
    }
    formatted.push(groups.join('-'));
  }

  return { plaintexts, formatted };
}

export function hashRecoveryCode(plaintext: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plaintext, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyRecoveryCode(plaintext: string, storedHash: string): boolean {
  return verifyPassword(plaintext, storedHash);
}

export function hashRecoveryCodeIndex(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
