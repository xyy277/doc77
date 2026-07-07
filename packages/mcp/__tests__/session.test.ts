import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '@doc77/core';
import { runMigrations } from '@doc77/core';
import {
  createSession,
  validateSession,
  touchSession,
  checkReadRateLimit,
  checkWriteRateLimit,
  cleanupExpiredSessions,
} from '../src/session.js';

describe('Session Management', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `doc77-session-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    initDatabase(dbPath);
    runMigrations();
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('createSession', () => {
    it('should create a new session with a UUID token', () => {
      const session = createSession();
      expect(session.id).toBeDefined();
      expect(session.id.length).toBeGreaterThan(10);
      expect(session.created_at).toBeDefined();
    });

    it('should generate unique session IDs', () => {
      const s1 = createSession();
      const s2 = createSession();
      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe('validateSession', () => {
    it('should validate a valid session', () => {
      const session = createSession();
      const result = validateSession(session.id);
      expect(result.valid).toBe(true);
    });

    it('should reject an invalid session ID', () => {
      const result = validateSession('nonexistent-id');
      expect(result.valid).toBe(false);
    });

    it('should reject an expired session', () => {
      const session = createSession();
      // Manually expire the session
      const db = getConnection();
      db.prepare("UPDATE sessions SET expired_at = datetime('now', '-1 hour') WHERE id = ?").run(
        session.id,
      );
      const result = validateSession(session.id);
      expect(result.valid).toBe(false);
    });
  });

  describe('touchSession', () => {
    it('should update last_active_at', () => {
      const session = createSession();
      touchSession(session.id);
      const db = getConnection();
      const row = db
        .prepare('SELECT last_active_at FROM sessions WHERE id = ?')
        .get(session.id) as { last_active_at: string };
      expect(row.last_active_at).toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    it('should allow reads within limit', () => {
      const session = createSession();
      const result = checkReadRateLimit(session.id);
      expect(result.allowed).toBe(true);
    });

    it('should track read count', () => {
      const session = createSession();
      // Simulate multiple reads within the same window
      for (let i = 0; i < 5; i++) {
        checkReadRateLimit(session.id);
      }
      const db = getConnection();
      const row = db.prepare('SELECT read_count FROM sessions WHERE id = ?').get(session.id) as {
        read_count: number;
      };
      expect(row.read_count).toBeGreaterThanOrEqual(5);
    });

    it('should allow writes within limit', () => {
      const session = createSession();
      const result = checkWriteRateLimit(session.id);
      expect(result.allowed).toBe(true);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should remove expired sessions', () => {
      const session = createSession();
      // Manually expire
      const db = getConnection();
      db.prepare("UPDATE sessions SET expired_at = datetime('now', '-1 hour') WHERE id = ?").run(
        session.id,
      );

      const removed = cleanupExpiredSessions();
      expect(removed).toBeGreaterThanOrEqual(1);
      // Session should no longer validate
      expect(validateSession(session.id).valid).toBe(false);
    });
  });
});
