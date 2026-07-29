/**
 * Keyring — manages encryption keys in memory (never persisted to disk).
 */
import { deriveKey, generateSalt, generateRecoveryCode, hashRecoveryCode } from './encrypt.js';

export interface KeyringState {
  unlocked: boolean;
  hasEncryption: boolean;
}

export class Keyring {
  private masterKey: Buffer | null = null;
  private salt: Buffer | null = null;
  private recoveryCodeHash: string | null = null;

  /**
   * Initialize encryption with a password. Generates salt + recovery code.
   */
  setup(password: string): { recoveryCode: string; salt: string } {
    this.salt = generateSalt();
    this.masterKey = deriveKey(password, this.salt);
    const recoveryCode = generateRecoveryCode();
    this.recoveryCodeHash = hashRecoveryCode(recoveryCode);
    return { recoveryCode, salt: this.salt.toString('base64') };
  }

  /**
   * Unlock with password.
   */
  unlock(password: string, saltBase64: string): boolean {
    this.salt = Buffer.from(saltBase64, 'base64');
    this.masterKey = deriveKey(password, this.salt);
    return true;
  }

  /**
   * Unlock with recovery code (re-derives key).
   */
  unlockWithRecovery(code: string, saltBase64: string): boolean {
    const hash = hashRecoveryCode(code);
    if (this.recoveryCodeHash && hash !== this.recoveryCodeHash) {
      return false;
    }
    this.salt = Buffer.from(saltBase64, 'base64');
    // Recovery code acts as password for key derivation
    this.masterKey = deriveKey(code.trim().toLowerCase(), this.salt);
    return true;
  }

  /**
   * Lock — clear key from memory.
   */
  lock(): void {
    if (this.masterKey) {
      this.masterKey.fill(0); // Zero out sensitive data
      this.masterKey = null;
    }
  }

  /**
   * Get the master key (throws if locked).
   */
  getKey(): Buffer {
    if (!this.masterKey) throw new Error('Keyring is locked');
    return this.masterKey;
  }

  getState(): KeyringState {
    return {
      unlocked: this.masterKey !== null,
      hasEncryption: this.salt !== null,
    };
  }
}

let _keyring: Keyring | null = null;
export function getKeyring(): Keyring {
  if (!_keyring) _keyring = new Keyring();
  return _keyring;
}
