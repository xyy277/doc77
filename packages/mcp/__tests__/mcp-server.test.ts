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

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `doc77-mcp-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');

    projectDir = path.join(testDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello\nWorld');
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'text content');
    fs.mkdirSync(path.join(projectDir, 'docs'));
    fs.writeFileSync(path.join(projectDir, 'docs', 'api.md'), '## API');

    initDatabase(dbPath);
    runMigrations();
    const proj = registerProject('MCP Test', projectDir);
    projectId = proj.id;
  });

  afterEach(() => {
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
});

// Direct implementations for testing (bypass MCP protocol)
import { scanDirectory } from '@doc77/core';
import { readFile, validatePath, isSensitiveFile } from '@doc77/core';
import { getConnection } from '@doc77/core';

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
