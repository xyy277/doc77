import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  deriveKey,
  generateSalt,
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  isSensitiveKey,
  maskSensitive,
} from '../src/crypto.js';

describe('Crypto module', () => {
  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt a string', () => {
      const key = deriveKey('test-password', generateSalt());
      const encrypted = encrypt('hello world', key);
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.tag).toBeDefined();
      expect(encrypted.ciphertext).toBeDefined();
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe('hello world');
    });

    it('should produce different ciphertext for same plaintext', () => {
      const key = deriveKey('pw', generateSalt());
      const e1 = encrypt('same', key);
      const e2 = encrypt('same', key);
      expect(e1.ciphertext).not.toBe(e2.ciphertext);
    });

    it('should fail to decrypt with wrong key', () => {
      const k1 = deriveKey('pw1', generateSalt());
      const k2 = deriveKey('pw2', generateSalt());
      const encrypted = encrypt('secret', k1);
      expect(() => decrypt(encrypted, k2)).toThrow();
    });
  });

  describe('deriveKey', () => {
    it('should produce a 32-byte key', () => {
      const key = deriveKey('password', generateSalt());
      expect(key.length).toBe(32);
    });

    it('should produce deterministic key for same inputs', () => {
      const salt = generateSalt();
      const k1 = deriveKey('pw', salt);
      const k2 = deriveKey('pw', salt);
      expect(k1.equals(k2)).toBe(true);
    });
  });

  describe('hashPassword/verifyPassword', () => {
    it('should verify correct password', () => {
      const hash = hashPassword('my-secure-password');
      expect(verifyPassword('my-secure-password', hash)).toBe(true);
    });

    it('should reject wrong password', () => {
      const hash = hashPassword('correct');
      expect(verifyPassword('wrong', hash)).toBe(false);
    });

    it('should reject invalid hash format', () => {
      expect(verifyPassword('pw', 'badhash')).toBe(false);
    });
  });

  describe('checkPasswordStrength', () => {
    it('should rate a weak password', () => {
      const result = checkPasswordStrength('123');
      expect(result.score).toBeLessThan(2);
    });

    it('should rate a strong password', () => {
      const result = checkPasswordStrength('MyP@ssw0rd2024!');
      expect(result.score).toBe(4);
    });
  });

  describe('isSensitiveKey', () => {
    it('should flag ai.token as sensitive', () => {
      expect(isSensitiveKey('ai.token')).toBe(true);
    });
    it('should flag shared_secret as sensitive', () => {
      expect(isSensitiveKey('security.shared_secret')).toBe(true);
    });
    it('should not flag regular keys', () => {
      expect(isSensitiveKey('ai.enabled')).toBe(false);
    });
  });

  describe('maskSensitive', () => {
    it('should mask a long value', () => {
      const masked = maskSensitive('sk-abc123def456ghi789');
      expect(masked).toContain('••••');
      expect(masked.length).toBeLessThan(15);
    });
    it('should handle short values', () => {
      expect(maskSensitive('ab')).toBe('••••');
    });
  });
});
