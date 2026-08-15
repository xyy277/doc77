import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';
import { scanDirectory, clearCache } from '../src/scanner/index.js';

// 包装 statSync 用于断言"缓存命中仅单次目录 stat"（node:fs 属性不可 redefine）
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
  };
});

describe('Directory Scanner', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(async () => {
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

    await initDatabase(dbPath);
    runMigrations();
    const project = registerProject('Scanner Test', projectDir);
    projectId = project.id;
  });

  afterEach(async () => {
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

    it('内容修改不使缓存失效（目录 mtime 不变；watcher clearCache 负责精确失效）', () => {
      scanDirectory(projectId, ''); // populate cache
      // Modify a file — dir mtime 不变，条目数不变
      fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'updated content');
      const result = scanDirectory(projectId, '');
      expect(result.cached).toBe(true);
    });

    it('新增条目使缓存失效（目录 mtime / 条目数变化）', () => {
      scanDirectory(projectId, ''); // populate cache
      fs.writeFileSync(path.join(projectDir, 'added-after.md'), 'x');
      const result = scanDirectory(projectId, '');
      expect(result.cached).toBe(false);
    });

    it('缓存命中仅做单次目录 stat（O(1) 校验，v1.1.4 F1）', () => {
      scanDirectory(projectId, ''); // populate cache
      vi.mocked(fs.statSync).mockClear();
      const result = scanDirectory(projectId, '');
      expect(result.cached).toBe(true);
      // 命中路径：isCacheValid 只 stat 目录本身，不再逐条目 statSync
      expect(vi.mocked(fs.statSync)).toHaveBeenCalledTimes(1);
    });

    it('should not write filetree_cache rows into DB (v1.1.4 in-memory cache)', () => {
      scanDirectory(projectId, '');
      scanDirectory(projectId, 'docs');
      clearCache(projectId, '');
      scanDirectory(projectId, '');
      const row = getConnection().prepare('SELECT COUNT(*) AS c FROM filetree_cache').get() as {
        c: number;
      };
      // 缓存已移入进程内 Map —— 表内必须零行，避免每次扫描触发
      // sql.js 整库序列化（1.1.4 性能修复的核心断言）
      expect(row.c).toBe(0);
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
