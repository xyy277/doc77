import { getConnection } from '../db/connection.js';
import * as crypto from '../crypto.js';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Legacy detection
// ---------------------------------------------------------------------------

/**
 * Returns true if a password is set but no DEK exists (legacy mode).
 * In legacy mode, the password was used directly for config encryption
 * without the envelope encryption layer (DEK).
 */
export function isLegacyMode(): boolean {
  const db = getConnection();
  const row = db.prepare(
    'SELECT password_hash, wrapped_dek_by_password FROM user_auth WHERE id = 1'
  ).get() as { password_hash: string | null; wrapped_dek_by_password: string | null } | undefined;
  return !!(row?.password_hash && !row?.wrapped_dek_by_password);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getAuthRow(): Record<string, unknown> | undefined {
  return getConnection()
    .prepare('SELECT * FROM user_auth WHERE id = 1')
    .get() as Record<string, unknown> | undefined;
}

function recoveryCodeToWrapKey(rcPlaintext: string): Buffer {
  const db = getConnection();
  const row = db.prepare('SELECT rc_wrap_salt FROM user_auth WHERE id = 1').get() as
    { rc_wrap_salt: string } | undefined;
  return crypto.hkdf(
    Buffer.from(rcPlaintext, 'utf-8'),
    Buffer.from(row!.rc_wrap_salt, 'hex'),
    'doc77-rc-wrap',
    32
  );
}

function signResetToken(codeIndex: number, dekPlaintext: Buffer): string {
  const db = getConnection();
  const row = db.prepare('SELECT jwt_salt FROM user_auth WHERE id = 1').get() as
    { jwt_salt: string } | undefined;
  const jwtKey = crypto.hkdf(dekPlaintext, Buffer.from(row!.jwt_salt, 'hex'), 'doc77-jwt-sign', 32);

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      code_index: codeIndex,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300, // 5 minutes
    })
  ).toString('base64url');

  const signature = createHmac('sha256', jwtKey)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

function verifyStoredResetToken(token: string): { valid: boolean; codeIndex?: number } {
  const state = resetState.get(token);
  if (!state || Date.now() > state.expiresAt) {
    if (state) resetState.delete(token);
    return { valid: false };
  }
  return { valid: true, codeIndex: state.codeIndex };
}

// In-memory store for DEK during reset flow (5-min TTL)
const resetState = new Map<string, { dek: Buffer; codeIndex: number; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Password setup with DEK
// ---------------------------------------------------------------------------

/**
 * Initialize the password and DEK envelope for a fresh installation.
 * Generates a DEK, wraps it with the password, generates recovery codes,
 * and stores everything in the database.
 *
 * Returns null if a password is already set.
 */
export function setupPasswordWithDEK(password: string): crypto.RecoveryCodeSet | null {
  const db = getConnection();
  const existing = db
    .prepare('SELECT password_hash FROM user_auth WHERE id = 1')
    .get() as { password_hash: string } | undefined;
  if (existing?.password_hash) return null; // already set

  const dek = crypto.generateDEK();
  const pwSalt = crypto.generateSalt();
  const pwWrapSalt = crypto.generateSalt();
  const rcWrapSalt = crypto.generateSalt();
  const jwtSalt = crypto.generateSalt();

  // Derive wrap key from password
  const scryptOutput = crypto.scryptSync(password, pwSalt, 64);
  const pwWrapKey = crypto.hkdf(scryptOutput, pwWrapSalt, 'doc77-pw-wrap', 32);
  const wrappedByPw = crypto.wrapDEK(dek, pwWrapKey);

  // Generate recovery codes
  const codes = crypto.generateRecoveryCodes(10);

  // Hash recovery codes and wrap DEK with each
  const codeHashes: string[] = [];
  const indexHashes: string[] = [];
  const wrappedByRc: crypto.EncryptedData[] = [];
  const used: boolean[] = [];

  for (const plaintext of codes.plaintexts) {
    codeHashes.push(crypto.hashRecoveryCode(plaintext));
    indexHashes.push(crypto.hashRecoveryCodeIndex(plaintext));
    const rcWrapKey = crypto.hkdf(
      Buffer.from(plaintext, 'utf-8'),
      rcWrapSalt,
      'doc77-rc-wrap',
      32
    );
    wrappedByRc.push(crypto.wrapDEK(dek, rcWrapKey));
    used.push(false);
  }

  // Store everything
  db.prepare(`
    INSERT OR REPLACE INTO user_auth (
      id, password_hash, pw_wrap_salt, rc_wrap_salt, jwt_salt,
      pbkdf2_salt, encryption_salt,
      wrapped_dek_by_password, wrapped_dek_by_recovery,
      recovery_code_hashes, recovery_code_index_hashes,
      recovery_codes_used, recovery_codes_generated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    `scrypt:${pwSalt.toString('hex')}:${scryptOutput.toString('hex')}`,
    pwWrapSalt.toString('hex'),
    rcWrapSalt.toString('hex'),
    jwtSalt.toString('hex'),
    crypto.generateSalt().toString('hex'), // pbkdf2_salt for legacy config encryption
    crypto.generateSalt().toString('hex'), // encryption_salt for legacy
    JSON.stringify(wrappedByPw),
    JSON.stringify(wrappedByRc),
    JSON.stringify(codeHashes),
    JSON.stringify(indexHashes),
    JSON.stringify(used),
  );

  return codes;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function verifyLogin(password: string): {
  ok: boolean;
  token?: string;
  error?: string;
  status: number;
} {
  const db = getConnection();
  const row = getAuthRow();

  if (!row?.password_hash) {
    return { ok: false, error: '未设置密码', status: 404 };
  }

  if (row.locked_until && new Date(row.locked_until as string) > new Date()) {
    return { ok: false, error: '账户已锁定，请稍后再试', status: 423 };
  }

  if (!crypto.verifyPassword(password, row.password_hash as string)) {
    const fails = ((row.failed_attempts as number) || 0) + 1;
    if (fails >= 5) {
      db.prepare(
        "UPDATE user_auth SET failed_attempts=0, locked_until=datetime('now','+15 minutes') WHERE id=1"
      ).run();
      return { ok: false, error: '密码错误次数过多，已锁定15分钟', status: 423 };
    }
    db.prepare('UPDATE user_auth SET failed_attempts=? WHERE id=1').run(fails);
    return { ok: false, error: `密码错误（${fails}/5）`, status: 401 };
  }

  db.prepare('UPDATE user_auth SET failed_attempts=0, locked_until=NULL WHERE id=1').run();
  return { ok: true, token: 'session-' + Date.now(), status: 200 };
}

// ---------------------------------------------------------------------------
// Forgot password: verify recovery code
// ---------------------------------------------------------------------------

export function verifyRecoveryCode(rcInput: string): {
  ok: boolean;
  resetToken?: string;
  remaining?: number;
  error?: string;
  status: number;
} {
  const db = getConnection();
  const row = getAuthRow();

  if (!row?.recovery_code_hashes) {
    return { ok: false, error: '未设置恢复码', status: 404 };
  }

  if (row.recovery_locked_until && new Date(row.recovery_locked_until as string) > new Date()) {
    const mins = Math.ceil(
      (new Date(row.recovery_locked_until as string).getTime() - Date.now()) / 60000
    );
    return { ok: false, error: `recovery_locked (${mins} min)`, status: 423 };
  }

  // Normalize: remove dashes
  const normalized = rcInput.replace(/-/g, '');

  const indexHashes: string[] = JSON.parse(row.recovery_code_index_hashes as string);
  const codeHashes: string[] = JSON.parse(row.recovery_code_hashes as string);
  const used: boolean[] = JSON.parse(row.recovery_codes_used as string);
  const wrappedByRc: crypto.EncryptedData[] = JSON.parse(row.wrapped_dek_by_recovery as string);

  // Fast SHA-256 index lookup
  const inputIndex = crypto.hashRecoveryCodeIndex(normalized);
  const matchIdx = indexHashes.indexOf(inputIndex);

  if (matchIdx === -1) {
    const fails = ((row.recovery_attempts as number) || 0) + 1;
    if (fails >= 5) {
      db.prepare(
        "UPDATE user_auth SET recovery_attempts=0, recovery_locked_until=datetime('now','+15 minutes') WHERE id=1"
      ).run();
      return { ok: false, error: 'recovery_locked (15 min)', status: 423 };
    }
    db.prepare('UPDATE user_auth SET recovery_attempts=? WHERE id=1').run(fails);
    return {
      ok: false,
      error: `invalid_recovery_code (${fails}/5)`,
      status: 401,
    };
  }

  // Slow scrypt verification
  if (!crypto.verifyRecoveryCode(normalized, codeHashes[matchIdx])) {
    const fails = ((row.recovery_attempts as number) || 0) + 1;
    if (fails >= 5) {
      db.prepare(
        "UPDATE user_auth SET recovery_attempts=0, recovery_locked_until=datetime('now','+15 minutes') WHERE id=1"
      ).run();
      return { ok: false, error: 'recovery_locked (15 min)', status: 423 };
    }
    db.prepare('UPDATE user_auth SET recovery_attempts=? WHERE id=1').run(fails);
    return {
      ok: false,
      error: `invalid_recovery_code (${fails}/5)`,
      status: 401,
    };
  }

  if (used[matchIdx]) {
    return { ok: false, error: 'recovery_code_already_used', status: 401 };
  }

  // Unwrap DEK with recovery code
  const rcWrapKey = recoveryCodeToWrapKey(normalized);
  const dek = crypto.unwrapDEK(wrappedByRc[matchIdx], rcWrapKey);

  // Sign reset token — store DEK in in-memory state
  const resetToken = signResetToken(matchIdx, dek);

  // Store for later verification (5-min TTL)
  resetState.set(resetToken, {
    dek,
    codeIndex: matchIdx,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const remaining = used.filter((u: boolean) => !u).length;

  db.prepare('UPDATE user_auth SET recovery_attempts=0 WHERE id=1').run();

  return { ok: true, resetToken, remaining, status: 200 };
}

// ---------------------------------------------------------------------------
// Forgot password: reset with token
// ---------------------------------------------------------------------------

export function resetPasswordWithToken(
  resetToken: string,
  newPassword: string
): { ok: boolean; error?: string; status: number } {
  const { valid, codeIndex } = verifyStoredResetToken(resetToken);
  if (!valid || codeIndex === undefined) {
    if (resetState.has(resetToken)) {
      return { ok: false, error: 'reset_token_expired', status: 401 };
    }
    return { ok: false, error: 'reset_token_invalid', status: 401 };
  }

  const state = resetState.get(resetToken)!;
  const dek = state.dek;
  const db = getConnection();
  const row = getAuthRow();

  const pwSalt = crypto.generateSalt();
  const pwWrapSaltHex = row?.pw_wrap_salt as string;
  const scryptOutput = crypto.scryptSync(newPassword, pwSalt, 64);
  const pwWrapKey = crypto.hkdf(
    scryptOutput,
    Buffer.from(pwWrapSaltHex, 'hex'),
    'doc77-pw-wrap',
    32
  );
  const wrappedByPw = crypto.wrapDEK(dek, pwWrapKey);

  // Update used flags
  const used: boolean[] = JSON.parse(row!.recovery_codes_used as string);
  used[codeIndex] = true;

  db.prepare(`
    UPDATE user_auth SET
      password_hash = ?,
      wrapped_dek_by_password = ?,
      recovery_codes_used = ?,
      failed_attempts = 0,
      locked_until = NULL,
      recovery_attempts = 0,
      recovery_locked_until = NULL
    WHERE id = 1
  `).run(
    `scrypt:${pwSalt.toString('hex')}:${scryptOutput.toString('hex')}`,
    JSON.stringify(wrappedByPw),
    JSON.stringify(used),
  );

  // Clean up in-memory state
  resetState.delete(resetToken);

  return { ok: true, status: 200 };
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

export function changePassword(
  oldPassword: string,
  newPassword: string
): { ok: boolean; codes?: crypto.RecoveryCodeSet; error?: string; status: number } {
  const db = getConnection();
  const row = getAuthRow();

  if (!row?.password_hash) {
    return { ok: false, error: '未设置密码', status: 404 };
  }

  if (!crypto.verifyPassword(oldPassword, row.password_hash as string)) {
    return { ok: false, error: 'current_password_wrong', status: 401 };
  }

  // Check if legacy mode — migrate to envelope encryption
  let wrappedByPw: crypto.EncryptedData;
  const pwWrapSaltHex = (row.pw_wrap_salt as string) || crypto.generateSalt().toString('hex');

  if (isLegacyMode() || !row.wrapped_dek_by_password) {
    // Legacy mode — generate new DEK and migrate
    const dek = crypto.generateDEK();
    const pwWrapSalt = crypto.generateSalt();
    const rcWrapSalt = crypto.generateSalt();
    const jwtSalt = crypto.generateSalt();

    const newPwSalt = crypto.generateSalt();
    const scryptOutput = crypto.scryptSync(newPassword, newPwSalt, 64);
    const pwWrapKey = crypto.hkdf(scryptOutput, pwWrapSalt, 'doc77-pw-wrap', 32);
    wrappedByPw = crypto.wrapDEK(dek, pwWrapKey);

    // Generate recovery codes for the migrated user
    const codes = crypto.generateRecoveryCodes(10);
    const codeHashes: string[] = [];
    const indexHashes: string[] = [];
    const wrappedByRc: crypto.EncryptedData[] = [];
    const used: boolean[] = [];

    for (const pt of codes.plaintexts) {
      codeHashes.push(crypto.hashRecoveryCode(pt));
      indexHashes.push(crypto.hashRecoveryCodeIndex(pt));
      const rcKey = crypto.hkdf(Buffer.from(pt, 'utf-8'), rcWrapSalt, 'doc77-rc-wrap', 32);
      wrappedByRc.push(crypto.wrapDEK(dek, rcKey));
      used.push(false);
    }

    db.prepare(`
      UPDATE user_auth SET
        password_hash = ?,
        pw_wrap_salt = ?,
        rc_wrap_salt = ?,
        jwt_salt = ?,
        wrapped_dek_by_password = ?,
        wrapped_dek_by_recovery = ?,
        recovery_code_hashes = ?,
        recovery_code_index_hashes = ?,
        recovery_codes_used = ?,
        recovery_codes_generated_at = datetime('now')
      WHERE id = 1
    `).run(
      `scrypt:${newPwSalt.toString('hex')}:${scryptOutput.toString('hex')}`,
      pwWrapSalt.toString('hex'),
      rcWrapSalt.toString('hex'),
      jwtSalt.toString('hex'),
      JSON.stringify(wrappedByPw),
      JSON.stringify(wrappedByRc),
      JSON.stringify(codeHashes),
      JSON.stringify(indexHashes),
      JSON.stringify(used),
    );

    return { ok: true, codes, status: 200 };
  }

  // Normal mode — unwrap DEK with old password, re-wrap with new
  const oldPwSalt = crypto.extractSalt(row.password_hash as string);
  const oldPwWrapKey = crypto.derivePasswordWrapKey(
    oldPassword,
    oldPwSalt,
    Buffer.from(row.pw_wrap_salt as string, 'hex')
  );

  let dek: Buffer;
  try {
    const wrapped: crypto.EncryptedData = JSON.parse(row.wrapped_dek_by_password as string);
    dek = crypto.unwrapDEK(wrapped, oldPwWrapKey);
  } catch {
    return { ok: false, error: 'dek_unwrap_failed', status: 500 };
  }

  const newPwSalt = crypto.generateSalt();
  const newScryptOutput = crypto.scryptSync(newPassword, newPwSalt, 64);
  const newPwWrapKey = crypto.hkdf(
    newScryptOutput,
    Buffer.from(row.pw_wrap_salt as string, 'hex'),
    'doc77-pw-wrap',
    32
  );
  wrappedByPw = crypto.wrapDEK(dek, newPwWrapKey);

  db.prepare(`
    UPDATE user_auth SET
      password_hash = ?,
      wrapped_dek_by_password = ?
    WHERE id = 1
  `).run(
    `scrypt:${newPwSalt.toString('hex')}:${newScryptOutput.toString('hex')}`,
    JSON.stringify(wrappedByPw),
  );

  return { ok: true, status: 200 };
}

// ---------------------------------------------------------------------------
// Recovery status
// ---------------------------------------------------------------------------

export function getRecoveryStatus(): { remaining: number; total: number; hasRecovery: boolean } {
  const row = getAuthRow();
  if (!row?.recovery_codes_used) return { remaining: 0, total: 0, hasRecovery: false };

  const used: boolean[] = JSON.parse(row.recovery_codes_used as string);
  return {
    remaining: used.filter((u: boolean) => !u).length,
    total: used.length,
    hasRecovery: true,
  };
}

// ---------------------------------------------------------------------------
// Regenerate recovery codes
// ---------------------------------------------------------------------------

export function regenerateRecoveryCodes(password: string): {
  ok: boolean;
  codes?: crypto.RecoveryCodeSet;
  error?: string;
  status: number;
} {
  const db = getConnection();
  const row = getAuthRow();

  if (!row?.password_hash) {
    return { ok: false, error: '未设置密码', status: 404 };
  }

  // Verify password
  if (!crypto.verifyPassword(password, row.password_hash as string)) {
    return { ok: false, error: 'current_password_wrong', status: 401 };
  }

  // Unwrap DEK with password using helper
  const pwSalt = crypto.extractSalt(row.password_hash as string);
  const pwWrapKey = crypto.derivePasswordWrapKey(
    password,
    pwSalt,
    Buffer.from(row.pw_wrap_salt as string, 'hex')
  );
  const wrapped: crypto.EncryptedData = JSON.parse(row.wrapped_dek_by_password as string);
  const dek = crypto.unwrapDEK(wrapped, pwWrapKey);

  // Generate new recovery codes
  const codes = crypto.generateRecoveryCodes(10);
  const codeHashes: string[] = [];
  const indexHashes: string[] = [];
  const wrappedByRc: crypto.EncryptedData[] = [];
  const used: boolean[] = [];

  for (const pt of codes.plaintexts) {
    codeHashes.push(crypto.hashRecoveryCode(pt));
    indexHashes.push(crypto.hashRecoveryCodeIndex(pt));
    const rcKey = crypto.hkdf(
      Buffer.from(pt, 'utf-8'),
      Buffer.from(row.rc_wrap_salt as string, 'hex'),
      'doc77-rc-wrap',
      32
    );
    wrappedByRc.push(crypto.wrapDEK(dek, rcKey));
    used.push(false);
  }

  db.prepare(`
    UPDATE user_auth SET
      wrapped_dek_by_recovery = ?,
      recovery_code_hashes = ?,
      recovery_code_index_hashes = ?,
      recovery_codes_used = ?,
      recovery_codes_generated_at = datetime('now')
    WHERE id = 1
  `).run(
    JSON.stringify(wrappedByRc),
    JSON.stringify(codeHashes),
    JSON.stringify(indexHashes),
    JSON.stringify(used),
  );

  return { ok: true, codes, status: 200 };
}

// ---------------------------------------------------------------------------
// Force reset
// ---------------------------------------------------------------------------

/**
 * Wipes all authentication state — password, DEK, recovery codes, salts.
 * Also clears encrypted config values (AI token, base URL, model).
 * Calling this effectively factory-resets the auth system.
 */
export function forceResetPassword(): void {
  const db = getConnection();
  db.prepare(`
    UPDATE user_auth SET
      password_hash = NULL,
      pw_wrap_salt = NULL,
      rc_wrap_salt = NULL,
      jwt_salt = NULL,
      wrapped_dek_by_password = NULL,
      wrapped_dek_by_recovery = NULL,
      recovery_code_hashes = NULL,
      recovery_code_index_hashes = NULL,
      recovery_codes_used = NULL,
      recovery_codes_generated_at = NULL,
      failed_attempts = 0,
      locked_until = NULL,
      recovery_attempts = 0,
      recovery_locked_until = NULL
    WHERE id = 1
  `).run();

  // Clear encrypted config values (AI token etc.)
  db.prepare("DELETE FROM config WHERE key IN ('ai.token', 'ai.base_url', 'ai.model')").run();
}
