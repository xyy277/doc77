import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  setupPasswordWithDEK,
  verifyLogin,
  changePassword,
  verifyRecoveryCode,
  resetPasswordWithToken,
  getRecoveryStatus,
  regenerateRecoveryCodes,
  forceResetPassword,
  isLegacyMode,
} from '../src/server/auth.js';

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('Password setup with DEK', () => {
  it('should setup password and return 10 recovery codes', () => {
    const codes = setupPasswordWithDEK('test-password');
    expect(codes).not.toBeNull();
    expect(codes!.plaintexts).toHaveLength(10);
    expect(codes!.formatted).toHaveLength(10);
    codes!.formatted.forEach((f) => {
      expect(f).toMatch(
        /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
      );
    });
  });

  it('should reject duplicate setup', () => {
    const codes = setupPasswordWithDEK('another-password');
    expect(codes).toBeNull();
  });

  it('should have recovery codes status', () => {
    const status = getRecoveryStatus();
    expect(status.hasRecovery).toBe(true);
    expect(status.total).toBe(10);
    expect(status.remaining).toBe(10);
  });
});

describe('Login', () => {
  it('should login with correct password', () => {
    const result = verifyLogin('test-password');
    expect(result.ok).toBe(true);
    expect(result.token).toBeTruthy();
    expect(result.status).toBe(200);
  });

  it('should reject wrong password', () => {
    const result = verifyLogin('wrong-password');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/密码错误/);
  });
});

describe('Forgot password flow', () => {
  let recoveryCode: string;
  let resetToken: string;

  it('should regenerate a fresh set of recovery codes', () => {
    const codes = regenerateRecoveryCodes('test-password');
    expect(codes.ok).toBe(true);
    expect(codes.status).toBe(200);
    expect(codes.codes!.plaintexts).toHaveLength(10);
    expect(codes.codes!.formatted).toHaveLength(10);
    // Use the plaintext code (25 chars, no padding) for verification
    recoveryCode = codes.codes!.plaintexts[0];
  });

  it('should verify a valid recovery code (remaining before consumption)', () => {
    const result = verifyRecoveryCode(recoveryCode);
    expect(result.ok).toBe(true);
    expect(result.resetToken).toBeTruthy();
    // verifyRecoveryCode returns remaining BEFORE marking as used
    expect(result.remaining).toBe(10);
    expect(result.status).toBe(200);
    resetToken = result.resetToken!;
  });

  it('should reset password with token', () => {
    const result = resetPasswordWithToken(resetToken, 'new-password');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('should login with new password', () => {
    const result = verifyLogin('new-password');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('should reject old password after reset', () => {
    const result = verifyLogin('test-password');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('should reject used recovery code', () => {
    const result = verifyRecoveryCode(recoveryCode);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('recovery_code_already_used');
    expect(result.status).toBe(401);
  });

  it('should show recovery remaining count decreased after reset', () => {
    const status = getRecoveryStatus();
    expect(status.remaining).toBe(9);
    expect(status.total).toBe(10);
    expect(status.hasRecovery).toBe(true);
  });
});

describe('Change password', () => {
  it('should change password successfully', () => {
    const result = changePassword('new-password', 'changed-password');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('should login with changed password', () => {
    const result = verifyLogin('changed-password');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('should reject old password', () => {
    const result = verifyLogin('new-password');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('should reject wrong old password', () => {
    const result = changePassword('wrong-old', 'another-new');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('current_password_wrong');
    expect(result.status).toBe(401);
  });
});

describe('Recovery codes regeneration', () => {
  it('should regenerate recovery codes', () => {
    const statusBefore = getRecoveryStatus();
    expect(statusBefore.remaining).toBe(9); // 1 used in forgot-password flow

    const result = regenerateRecoveryCodes('changed-password');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.codes!.plaintexts).toHaveLength(10);
    expect(result.codes!.formatted).toHaveLength(10);

    // After regeneration, all 10 codes are fresh (non-used)
    const statusAfter = getRecoveryStatus();
    expect(statusAfter.remaining).toBe(10);
    expect(statusAfter.total).toBe(10);
    expect(statusAfter.hasRecovery).toBe(true);
  });

  it('should reject regeneration with wrong password', () => {
    const result = regenerateRecoveryCodes('wrong-password');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('current_password_wrong');
    expect(result.status).toBe(401);
  });
});

describe('Force reset', () => {
  it('should force reset and clear everything', () => {
    // Verify we have auth data before reset
    const statusBefore = getRecoveryStatus();
    expect(statusBefore.hasRecovery).toBe(true);

    forceResetPassword();

    const statusAfter = getRecoveryStatus();
    expect(statusAfter.hasRecovery).toBe(false);
    expect(statusAfter.remaining).toBe(0);
    expect(statusAfter.total).toBe(0);

    // Should be able to set up again
    const codes = setupPasswordWithDEK('fresh-password');
    expect(codes).not.toBeNull();
    expect(codes!.plaintexts).toHaveLength(10);

    // Login with new password should work
    const loginResult = verifyLogin('fresh-password');
    expect(loginResult.ok).toBe(true);
    expect(loginResult.status).toBe(200);
  });
});

describe('Legacy mode detection', () => {
  it('should detect non-legacy mode after force reset and new setup', () => {
    // After force reset + setupPasswordWithDEK, we should have wrapped_dek_by_password set
    expect(isLegacyMode()).toBe(false);
  });
});
