import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '@doc77/core';
import { runMigrations } from '@doc77/core';
import { registerProject } from '@doc77/core';
import { createMcpServer } from '../src/server.js';

describe('MCP Server Bootstrap', () => {
  it('should create an MCP server with correct name', () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});

describe('MCP Read-only Tools', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-mcp-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');

    projectDir = path.join(testDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello\nWorld');
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'text content');
    fs.mkdirSync(path.join(projectDir, 'docs'));
    fs.writeFileSync(path.join(projectDir, 'docs', 'api.md'), '## API');

    await initDatabase(dbPath);
    runMigrations();
    const proj = registerProject('MCP Test', projectDir);
    projectId = proj.id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('list_files', () => {
    it('should list files in project root', async () => {
      const files = await listFilesImpl(projectId, '');
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      const names = files.map((f: { name: string }) => f.name);
      expect(names).toContain('README.md');
      expect(names).toContain('docs');
    });

    it('should list files in subdirectory', async () => {
      const files = await listFilesImpl(projectId, 'docs');
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].name).toBe('api.md');
    });

    it('should include file size and type info', async () => {
      const files = await listFilesImpl(projectId, '');
      const readme = files.find((f: { name: string }) => f.name === 'README.md');
      expect(readme).toBeDefined();
      expect(readme.type).toBe('file');
      expect(readme.size).toBeGreaterThan(0);
      expect(readme.modified).toBeDefined();
    });

    it('should filter sensitive files', async () => {
      // Create sensitive files
      fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET');
      fs.writeFileSync(path.join(projectDir, 'server.key'), 'KEY');
      const files = await listFilesImpl(projectId, '');
      const names = files.map((f: { name: string }) => f.name);
      expect(names).not.toContain('.env');
      expect(names).not.toContain('server.key');
    });

    it('should throw for invalid project', async () => {
      await expect(listFilesImpl(99999, '')).rejects.toThrow();
    });
  });

  describe('read_file', () => {
    it('should read file content', async () => {
      const content = await readFileImpl(projectId, 'README.md');
      expect(content).toContain('# Hello');
    });

    it('should throw when reading sensitive files', async () => {
      fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=123');
      await expect(readFileImpl(projectId, '.env')).rejects.toThrow();
    });

    it('should throw for path traversal attempts', async () => {
      await expect(readFileImpl(projectId, '../../../etc/passwd')).rejects.toThrow();
    });

    it('should throw for non-existent file', async () => {
      await expect(readFileImpl(projectId, 'no-such-file.txt')).rejects.toThrow();
    });
  });

  describe('read_file enhanced', () => {
    it('should read specific line range', async () => {
      fs.writeFileSync(path.join(projectDir, 'multiline.txt'), 'line1\nline2\nline3\nline4\n');
      const content = await readFileContentEnhanced(projectId, 'multiline.txt', {
        start_line: 2,
        end_line: 3,
      });
      expect(content).toBe('line2\nline3');
    });

    it('should read from start_line to end of file when end_line omitted', async () => {
      fs.writeFileSync(path.join(projectDir, 'lines.txt'), 'a\nb\nc\nd\ne\n');
      const content = await readFileContentEnhanced(projectId, 'lines.txt', { start_line: 3 });
      expect(content).toBe('c\nd\ne');
    });

    it('should handle single line range', async () => {
      fs.writeFileSync(path.join(projectDir, 'single.txt'), 'only line\n');
      const content = await readFileContentEnhanced(projectId, 'single.txt', {
        start_line: 1,
        end_line: 1,
      });
      expect(content).toBe('only line');
    });

    it('should read full content with non-utf8 encoding (latin1)', async () => {
      // Write a file with latin1-encodable bytes
      const buf = Buffer.from([0xe9, 0xe8, 0xea, 0x0a]); // éèê\n
      fs.writeFileSync(path.join(projectDir, 'latin1.txt'), buf);
      const content = await readFileContentEnhanced(projectId, 'latin1.txt', {
        encoding: 'latin1',
      });
      expect(content).toBe('éèê\n');
    });

    it('should truncate large file (>1MB) without start_line', async () => {
      // Create a file >1MB
      const bigFilePath = path.join(projectDir, 'bigfile.txt');
      const line = 'x'.repeat(100) + '\n';
      const fd = fs.openSync(bigFilePath, 'w');
      for (let i = 0; i < 12000; i++) {
        fs.writeSync(fd, line);
      }
      fs.closeSync(fd);
      const stats = fs.statSync(bigFilePath);
      expect(stats.size).toBeGreaterThan(1024 * 1024);

      const content = await readFileContentEnhanced(projectId, 'bigfile.txt');
      expect(content).toContain('[File is');
      expect(content).toContain('MB. Use start_line/end_line for partial reads.]');
      // Should have ~100 lines
      const lines = content.split('\n');
      expect(lines.length).toBeLessThan(200);
    });

    it('should allow reading large file with start_line specified', async () => {
      const bigFilePath = path.join(projectDir, 'bigfile2.txt');
      const line = 'data line\n';
      const fd = fs.openSync(bigFilePath, 'w');
      for (let i = 0; i < 12000; i++) {
        fs.writeSync(fd, line);
      }
      fs.closeSync(fd);

      const content = await readFileContentEnhanced(projectId, 'bigfile2.txt', {
        start_line: 1,
        end_line: 5,
      });
      const lines = content.split('\n');
      expect(lines.length).toBe(5);
      expect(lines[0]).toBe('data line');
    });
  });

  describe('read_files batch', () => {
    it('should read multiple files', async () => {
      fs.writeFileSync(path.join(projectDir, 'f1.txt'), 'file1');
      fs.writeFileSync(path.join(projectDir, 'f2.txt'), 'file2');
      const results = await readFiles(projectId, ['f1.txt', 'f2.txt']);
      expect(results).toHaveLength(2);
      expect(results[0].file_path).toBe('f1.txt');
      expect(results[0].content).toBe('file1');
      expect(results[1].file_path).toBe('f2.txt');
      expect(results[1].content).toBe('file2');
    });

    it('should not fail on non-existent file — returns error entry', async () => {
      const results = await readFiles(projectId, ['README.md', 'no-such-file.txt']);
      expect(results).toHaveLength(2);
      expect(results[0].file_path).toBe('README.md');
      expect(results[0].content).toBeDefined();
      expect(results[0].error).toBeUndefined();
      expect(results[1].file_path).toBe('no-such-file.txt');
      expect(results[1].content).toBeNull();
      expect(results[1].error).toBeDefined();
    });

    it('should handle empty file list', async () => {
      const results = await readFiles(projectId, []);
      expect(results).toHaveLength(0);
    });

    it('should handle sensitive file reads without blocking others', async () => {
      fs.writeFileSync(path.join(projectDir, 'good.txt'), 'good content');
      fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=123');
      fs.writeFileSync(path.join(projectDir, 'also_good.txt'), 'also good');
      const results = await readFiles(projectId, ['good.txt', '.env', 'also_good.txt']);
      expect(results).toHaveLength(3);
      expect(results[0].file_path).toBe('good.txt');
      expect(results[0].content).toBe('good content');
      expect(results[1].file_path).toBe('.env');
      expect(results[1].content).toBeNull();
      expect(results[1].error).toContain('sensitive');
      expect(results[2].file_path).toBe('also_good.txt');
      expect(results[2].content).toBe('also good');
    });
  });

  describe('get_file_info', () => {
    it('should return file metadata', async () => {
      const info = await getFileInfoImpl(projectId, 'README.md');
      expect(info.name).toBe('README.md');
      expect(info.type).toBe('file');
      expect(info.size).toBeGreaterThan(0);
      expect(info.modified).toBeDefined();
    });

    it('should return directory metadata', async () => {
      const info = await getFileInfoImpl(projectId, 'docs');
      expect(info.type).toBe('directory');
    });
  });

  describe('list_files enhanced (depth, glob, sort_by, pagination)', () => {
    let testDir2: string;
    let projectId2: number;

    beforeEach(async () => {
      testDir2 = path.join(os.tmpdir(), `doc77-deep-${Date.now()}`);
      fs.mkdirSync(testDir2, { recursive: true });
      const dbPath2 = path.join(testDir2, 'data.db');
      await initDatabase(dbPath2);
      runMigrations();

      const projDir = path.join(testDir2, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      fs.mkdirSync(path.join(projDir, 'sub'));
      fs.writeFileSync(path.join(projDir, 'a.md'), 'a');
      fs.writeFileSync(path.join(projDir, 'b.txt'), 'b');
      fs.writeFileSync(path.join(projDir, 'sub', 'c.md'), 'c');
      fs.writeFileSync(path.join(projDir, 'sub', 'd.js'), 'd');

      const proj = registerProject('Deep Test', projDir);
      projectId2 = proj.id;
    });

    afterEach(() => {
      try {
        closeConnection();
      } catch {
        /* ignore */
      }
      fs.rmSync(testDir2, { recursive: true, force: true });
    });

    it('should support depth=0 (unlimited recursion)', async () => {
      const files = await listFilesEnhanced(projectId2, '', { depth: 0 });
      const names = files.map((f) => f.name);
      expect(names.some((n) => n.includes('sub/'))).toBe(true);
    });

    it('should support glob filter', async () => {
      const files = await listFilesEnhanced(projectId2, '', { depth: 0, glob: '*.md' });
      const entries = files.filter((e) => e.type !== 'directory');
      expect(entries.every((e) => e.name.endsWith('.md'))).toBe(true);
    });

    it('should support sort_by=name', async () => {
      const files = await listFilesEnhanced(projectId2, '', { sort_by: 'name' });
      expect(files.length).toBeGreaterThan(1);
      for (let i = 1; i < files.length; i++) {
        expect(files[i].name.localeCompare(files[i - 1].name)).toBeGreaterThanOrEqual(0);
      }
    });

    it('should support pagination with offset/limit', async () => {
      const page = await listFilesEnhanced(projectId2, '', { depth: 0, offset: 0, limit: 1 });
      expect(page.length).toBeLessThanOrEqual(1);
    });

    it('should respect depth=1 (default, no recursion)', async () => {
      const files = await listFilesEnhanced(projectId2, '', { depth: 1 });
      const names = files.map((f) => f.name);
      expect(names).toContain('sub');
      expect(names).toContain('a.md');
      expect(names.some((n) => n.includes('/'))).toBe(false);
    });

    it('should apply sort_by=size', async () => {
      const files = await listFilesEnhanced(projectId2, '', { sort_by: 'size' });
      for (let i = 1; i < files.length; i++) {
        expect(files[i - 1].size).toBeGreaterThanOrEqual(files[i].size);
      }
    });
  });
});

// Direct implementations for testing (bypass MCP protocol)
import { scanDirectory } from '@doc77/core';
import { readFile, validatePath, isSensitiveFile } from '@doc77/core';
import { getConnection, registerProject } from '@doc77/core';
import {
  listFiles as listFilesEnhanced,
  readFileContent as readFileContentEnhanced,
  readFiles,
} from '../src/tools/readonly.js';

async function listFilesImpl(projectId: number, dirPath: string) {
  const result = scanDirectory(projectId, dirPath);
  return result.entries;
}

async function readFileImpl(projectId: number, filePath: string) {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;
  if (!project) throw new Error('Project not found');

  if (isSensitiveFile(path.basename(filePath))) {
    throw new Error('Access denied: sensitive file');
  }

  const absPath = validatePath(project.path, filePath);
  return readFile(absPath);
}

async function getFileInfoImpl(projectId: number, filePath: string) {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;
  if (!project) throw new Error('Project not found');

  const absPath = validatePath(project.path, filePath);
  const stats = fs.statSync(absPath);
  return {
    name: path.basename(filePath),
    type: stats.isDirectory() ? 'directory' : 'file',
    size: stats.size,
    modified: stats.mtime.toISOString(),
  };
}
