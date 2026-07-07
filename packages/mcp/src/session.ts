import { randomUUID } from 'node:crypto';
import { getConnection } from '@doc77/core';

/**
 * Session record returned from the database.
 */
export interface Session {
  id: string;
  created_at: string;
  last_active_at: string;
}

/**
 * Validation result for session checks.
 */
export interface SessionValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Rate limit check result.
 */
export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/** Default read limit per 5-minute window */
const DEFAULT_READ_LIMIT = 200;
/** Default write limit per 5-minute window */
const DEFAULT_WRITE_LIMIT = 50;
/** Default session idle timeout in minutes */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 120;
/** Rate limit window in minutes */
const RATE_WINDOW_MINUTES = 5;

/**
 * Create a new session with a UUID token.
 */
export function createSession(): Session {
  const db = getConnection();
  const id = randomUUID();
  const now = new Date().toISOString();
  const windowStart = now;

  // Calculate expiry
  const expiry = new Date(Date.now() + DEFAULT_IDLE_TIMEOUT_MINUTES * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, read_count, read_window_start, write_count, write_window_start, expired_at)
     VALUES (?, ?, ?, 0, ?, 0, ?, ?)`,
  ).run(id, now, now, windowStart, windowStart, expiry);

  return { id, created_at: now, last_active_at: now };
}

/**
 * Validate a session token.
 * Checks existence and expiry.
 */
export function validateSession(sessionId: string): SessionValidation {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT id, expired_at FROM sessions
       WHERE id = ?
       AND (expired_at IS NULL OR datetime(expired_at) > datetime('now'))`,
    )
    .get(sessionId) as { id: string; expired_at: string | null } | undefined;

  if (!row) {
    return { valid: false, reason: 'Invalid or expired session' };
  }

  return { valid: true };
}

/**
 * Update the last_active_at timestamp for a session.
 */
export function touchSession(sessionId: string): void {
  const db = getConnection();
  db.prepare("UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?").run(sessionId);
}

/**
 * Check if a read operation is within rate limits.
 * Increments the read counter on each call.
 */
export function checkReadRateLimit(sessionId: string): RateLimitResult {
  const db = getConnection();

  // Reset window if it's expired
  db.prepare(
    `UPDATE sessions
     SET read_count = 0, read_window_start = datetime('now')
     WHERE id = ?
     AND datetime(read_window_start, '+' || ? || ' minutes') < datetime('now')`,
  ).run(sessionId, RATE_WINDOW_MINUTES);

  // Get current count
  const row = db.prepare('SELECT read_count FROM sessions WHERE id = ?').get(sessionId) as
    { read_count: number } | undefined;

  if (!row) {
    return { allowed: false, reason: 'Invalid session' };
  }

  if (row.read_count >= DEFAULT_READ_LIMIT) {
    return {
      allowed: false,
      reason: `Read rate limit exceeded (${DEFAULT_READ_LIMIT} per ${RATE_WINDOW_MINUTES} minutes)`,
    };
  }

  // Increment
  db.prepare('UPDATE sessions SET read_count = read_count + 1 WHERE id = ?').run(sessionId);

  return { allowed: true };
}

/**
 * Check if a write operation is within rate limits.
 * Increments the write counter on each call.
 */
export function checkWriteRateLimit(sessionId: string): RateLimitResult {
  const db = getConnection();

  // Reset window if it's expired
  db.prepare(
    `UPDATE sessions
     SET write_count = 0, write_window_start = datetime('now')
     WHERE id = ?
     AND datetime(write_window_start, '+' || ? || ' minutes') < datetime('now')`,
  ).run(sessionId, RATE_WINDOW_MINUTES);

  // Get current count
  const row = db.prepare('SELECT write_count FROM sessions WHERE id = ?').get(sessionId) as
    { write_count: number } | undefined;

  if (!row) {
    return { allowed: false, reason: 'Invalid session' };
  }

  if (row.write_count >= DEFAULT_WRITE_LIMIT) {
    return {
      allowed: false,
      reason: `Write rate limit exceeded (${DEFAULT_WRITE_LIMIT} per ${RATE_WINDOW_MINUTES} minutes)`,
    };
  }

  // Increment
  db.prepare('UPDATE sessions SET write_count = write_count + 1 WHERE id = ?').run(sessionId);

  return { allowed: true };
}

/**
 * Clean up expired sessions.
 * Returns the number of sessions removed.
 */
export function cleanupExpiredSessions(): number {
  const db = getConnection();
  const result = db
    .prepare(
      "DELETE FROM sessions WHERE expired_at IS NOT NULL AND datetime(expired_at) < datetime('now')",
    )
    .run();
  return result.changes;
}
