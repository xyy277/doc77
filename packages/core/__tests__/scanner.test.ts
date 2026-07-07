import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';
import { scanDirectory, clearCache } from '../src/scanner/index.js';

describe('Directory Scanner', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `doc77-scanner-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');

    // Create a project directory structure
    projectDir = path.join(testDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Test');
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'notes');
    fs.mkdirSync(path.join(projectDir, 'docs'));
    fs.writeFileSync(path.join(projectDir, 'docs', 'api.md'), '# API');
    fs.mkdirSync(path.join(projectDir, '.git'));
    fs.writeFileSync(path.join(projectDir, '.git', 'config'), '');
    fs.mkdirSync(path.join(projectDir, 'node_modules'));
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'dep.js'), '');
    fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=123');

    initDatabase(dbPath);
    runMigrations();
    const project = registerProject('Scanner Test', projectDir);
    projectId = project.id;
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('scanDirectory', () => {
    it('should scan root directory of a project', () => {
      const result = scanDirectory(projectId, '');
      expect(result).toBeDefined();
      expect(result.path).toBe('');
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('should return files and directories', () => {
      const result = scanDirectory(projectId, '');
      const files = result.entries.filter((e) => e.type === 'file');
      const dirs = result.entries.filter((e) => e.type === 'directory');
      expect(files.length).toBeGreaterThan(0);
      expect(dirs.length).toBeGreaterThan(0);
    });

    it('should include size and modified time for files', () => {
      const result = scanDirectory(projectId, '');
      const readme = result.entries.find((e) => e.name === 'README.md');
      expect(readme).toBeDefined();
      expect(readme!.size).toBeGreaterThan(0);
      expect(readme!.modified).toBeDefined();
    });

    it('should filter ignored patterns', () => {
      const result = scanDirectory(projectId, '');
      const names = result.entries.map((e) => e.name);
      expect(names).not.toContain('.git');
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('.env');
    });

    it('should scan subdirectory on demand (lazy loading)', () => {
      const result = scanDirectory(projectId, 'docs');
      expect(result.path).toBe('docs');
      expect(result.entries.some((e) => e.name === 'api.md')).toBe(true);
    });

    it('should only return direct children, not recursive', () => {
      const result = scanDirectory(projectId, '');
      const dirNames = result.entries.filter((e) => e.type === 'directory').map((e) => e.name);
      // docs is there, but api.md should not be in root
      expect(dirNames).toContain('docs');
      const allFiles = result.entries.map((e) => e.name);
      expect(allFiles).not.toContain('api.md');
    });

    it('should use cache on second call', () => {
      const first = scanDirectory(projectId, '');
      const second = scanDirectory(projectId, '');
      expect(second.cached).toBe(true);
      expect(second.entries).toEqual(first.entries);
    });

    it('should invalidate cache when a file changes', () => {
      scanDirectory(projectId, ''); // populate cache
      // Modify a file
      fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'updated content');
      const result = scanDirectory(projectId, '');
      expect(result.cached).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear cache for a specific project path', () => {
      scanDirectory(projectId, '');
      clearCache(projectId, '');
      const result = scanDirectory(projectId, '');
      expect(result.cached).toBe(false);
    });

    it('should clear all cache for a project', () => {
      scanDirectory(projectId, '');
      scanDirectory(projectId, 'docs');
      clearCache(projectId);
      const root = scanDirectory(projectId, '');
      const docs = scanDirectory(projectId, 'docs');
      expect(root.cached).toBe(false);
      expect(docs.cached).toBe(false);
    });
  });
});
