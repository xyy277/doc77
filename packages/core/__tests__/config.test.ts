import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { getConfig, setConfig, listConfig, loadDefaults } from '../src/db/config.js';

describe('Config management', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-config-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('getConfig', () => {
    it('should return undefined for non-existent key', () => {
      expect(getConfig('nonexistent.key')).toBeUndefined();
    });

    it('should return a string value after set', () => {
      setConfig('test.key', 'hello');
      expect(getConfig('test.key')).toBe('hello');
    });

    it('should return a numeric value as string', () => {
      setConfig('test.number', '42');
      expect(getConfig('test.number')).toBe('42');
    });
  });

  describe('setConfig', () => {
    it('should insert a new config entry', () => {
      setConfig('my.key', 'my-value');
      const row = getConnection().prepare('SELECT value FROM config WHERE key = ?').get('my.key') as {
        value: string;
      };
      expect(row.value).toBe('my-value');
    });

    it('should update an existing config entry', () => {
      setConfig('update.key', 'old');
      setConfig('update.key', 'new');
      expect(getConfig('update.key')).toBe('new');
    });
  });

  describe('listConfig', () => {
    it('should return empty object when no config exists', () => {
      const all = listConfig();
      expect(all).toEqual({});
    });

    it('should return all key-value pairs', () => {
      setConfig('a', '1');
      setConfig('b', '2');
      const all = listConfig();
      expect(all).toEqual({ a: '1', b: '2' });
    });
  });

  describe('loadDefaults', () => {
    it('should insert all default config values', () => {
      loadDefaults();
      const all = listConfig();
      expect(Object.keys(all).length).toBeGreaterThan(0);
    });

    it('should set expected default values', () => {
      loadDefaults();
      expect(getConfig('transaction.file_size_threshold_mb')).toBe('50');
      expect(getConfig('ai.enabled')).toBe('false');
      expect(getConfig('ai.auto_mode')).toBe('false');
      expect(getConfig('security.bind_address')).toBe('127.0.0.1');
      expect(getConfig('editor.default')).toBe('vscode');
      expect(getConfig('concurrency.lock_timeout_minutes')).toBe('10');
    });

    it('should not overwrite existing config values', () => {
      setConfig('ai.enabled', 'true');
      loadDefaults();
      expect(getConfig('ai.enabled')).toBe('true');
    });

    it('should fill in missing defaults while keeping existing', () => {
      setConfig('editor.default', 'sublime');
      loadDefaults();
      expect(getConfig('editor.default')).toBe('sublime');
      expect(getConfig('ai.enabled')).toBe('false');
    });
  });
});
