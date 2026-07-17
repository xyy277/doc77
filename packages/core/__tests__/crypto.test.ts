import { describe, it, expect } from 'vitest';
import {
  hkdf,
  encodeBase32Crockford,
  decodeBase32Crockford,
  crc16Base32,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../src/crypto.js';

describe('hkdf', () => {
  it('should derive a key of the requested length', () => {
    const ikm = Buffer.from('test-input-key-material');
    const salt = Buffer.from('test-salt');
    const key = hkdf(ikm, salt, 'doc77-test', 32);
    expect(key).toHaveLength(32);
  });

  it('should produce deterministic output', () => {
    const ikm = Buffer.from('test-input');
    const salt = Buffer.from('salt');
    const a = hkdf(ikm, salt, 'doc77-test', 32);
    const b = hkdf(ikm, salt, 'doc77-test', 32);
    expect(a.equals(b)).toBe(true);
  });

  it('should produce different output with different info', () => {
    const ikm = Buffer.from('test-input');
    const salt = Buffer.from('salt');
    const a = hkdf(ikm, salt, 'doc77-a', 32);
    const b = hkdf(ikm, salt, 'doc77-b', 32);
    expect(a.equals(b)).toBe(false);
  });
});

describe('Crockford Base32', () => {
  it('should encode and decode round-trip', () => {
    const input = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const encoded = encodeBase32Crockford(input);
    const decoded = decodeBase32Crockford(encoded);
    expect(decoded.equals(input)).toBe(true);
  });

  it('should not contain ambiguous characters', async () => {
    // Generate random bytes and encode
    const crypto = await import('node:crypto');
    for (let i = 0; i < 100; i++) {
      const bytes = crypto.randomBytes(15);
      const encoded = encodeBase32Crockford(bytes);
      expect(encoded).not.toMatch(/[ILOUilou]/);
    }
  });

  it('should encode 15 bytes to 24 characters', () => {
    const bytes = Buffer.alloc(15, 0xab);
    const encoded = encodeBase32Crockford(bytes);
    expect(encoded).toHaveLength(24);
  });
});

describe('crc16Base32', () => {
  it('should compute CRC-16 for a base32 string', () => {
    const result = crc16Base32('ABCDEFGH');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(31); // 5 bits for Base32 digit
  });
});

describe('DEK envelope', () => {
  it('should generate a 32-byte DEK', () => {
    const dek = generateDEK();
    expect(dek).toHaveLength(32);
  });

  it('should generate unique DEKs', () => {
    const a = generateDEK();
    const b = generateDEK();
    expect(a.equals(b)).toBe(false);
  });

  it('should wrap and unwrap DEK round-trip', () => {
    const dek = generateDEK();
    const key = Buffer.alloc(32, 0xaa);
    const wrapped = wrapDEK(dek, key);
    const unwrapped = unwrapDEK(wrapped, key);
    expect(dek.equals(unwrapped)).toBe(true);
  });

  it('should fail unwrap with wrong key', () => {
    const dek = generateDEK();
    const keyA = Buffer.alloc(32, 0xaa);
    const keyB = Buffer.alloc(32, 0xbb);
    const wrapped = wrapDEK(dek, keyA);
    expect(() => unwrapDEK(wrapped, keyB)).toThrow();
  });
});

describe('recovery codes', () => {
  it('should generate 10 recovery codes', () => {
    const { plaintexts, formatted } = generateRecoveryCodes(10);
    expect(plaintexts).toHaveLength(10);
    expect(formatted).toHaveLength(10);
  });

  it('should format as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX', () => {
    const { formatted } = generateRecoveryCodes(1);
    expect(formatted[0]).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it('should verify a hashed recovery code', () => {
    const { plaintexts } = generateRecoveryCodes(1);
    const hash = hashRecoveryCode(plaintexts[0]);
    expect(verifyRecoveryCode(plaintexts[0], hash)).toBe(true);
  });

  it('should reject wrong recovery code', () => {
    const { plaintexts } = generateRecoveryCodes(2);
    const hash = hashRecoveryCode(plaintexts[0]);
    expect(verifyRecoveryCode(plaintexts[1], hash)).toBe(false);
  });
});
