import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { readFile, statFile, listDir, isSensitiveFile, validatePath } from '../src/fs/index.js';

describe('File system abstraction', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `doc77-fs-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Create test structure
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Hello\nWorld');
    fs.writeFileSync(path.join(testDir, '.env'), 'SECRET=abc');
    fs.writeFileSync(path.join(testDir, 'cert.key'), 'PRIVATE KEY');
    fs.mkdirSync(path.join(testDir, 'subdir'));
    fs.writeFileSync(path.join(testDir, 'subdir', 'notes.txt'), 'notes');
    fs.mkdirSync(path.join(testDir, '.git'));
    fs.writeFileSync(path.join(testDir, '.git', 'config'), 'git config');
    // Symlink test
    fs.mkdirSync(path.join(testDir, 'real-dir'));
    fs.writeFileSync(path.join(testDir, 'real-dir', 'safe.txt'), 'safe');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('readFile', () => {
    it('should read a text file', () => {
      const content = readFile(path.join(testDir, 'README.md'));
      expect(content).toBe('# Hello\nWorld');
    });

    it('should throw for non-existent file', () => {
      expect(() => readFile(path.join(testDir, 'nonexistent.txt'))).toThrow();
    });
  });

  describe('statFile', () => {
    it('should return file stats', () => {
      const stats = statFile(path.join(testDir, 'README.md'));
      expect(stats).toBeDefined();
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should return directory stats', () => {
      const stats = statFile(path.join(testDir, 'subdir'));
      expect(stats.isDirectory()).toBe(true);
    });

    it('should throw for non-existent path', () => {
      expect(() => statFile(path.join(testDir, 'nonexistent'))).toThrow();
    });
  });

  describe('listDir', () => {
    it('should list directory contents without sensitive files by default', () => {
      const entries = listDir(testDir);
      const names = entries.map((e) => e.name);
      expect(names).toContain('README.md');
      expect(names).toContain('subdir');
      expect(names).toContain('real-dir');
      // Sensitive files filtered by default
      expect(names).not.toContain('.env');
      expect(names).not.toContain('cert.key');
      expect(names).not.toContain('.git');
    });

    it('should include size and type for each entry', () => {
      const entries = listDir(testDir);
      const readme = entries.find((e) => e.name === 'README.md');
      expect(readme).toBeDefined();
      expect(readme!.type).toBe('file');
      expect(readme!.size).toBeGreaterThan(0);
      expect(readme!.modified).toBeDefined();

      const subdir = entries.find((e) => e.name === 'subdir');
      expect(subdir).toBeDefined();
      expect(subdir!.type).toBe('directory');
    });
  });

  describe('isSensitiveFile', () => {
    it('should flag .env as sensitive', () => {
      expect(isSensitiveFile('.env')).toBe(true);
    });

    it('should flag *.key files as sensitive', () => {
      expect(isSensitiveFile('server.key')).toBe(true);
    });

    it('should flag *.pem files as sensitive', () => {
      expect(isSensitiveFile('cert.pem')).toBe(true);
    });

    it('should flag .git directory as sensitive', () => {
      expect(isSensitiveFile('.git')).toBe(true);
    });

    it('should not flag regular files', () => {
      expect(isSensitiveFile('README.md')).toBe(false);
      expect(isSensitiveFile('notes.txt')).toBe(false);
    });
  });

  describe('validatePath', () => {
    it('should accept a path within project root', () => {
      const resolved = validatePath(testDir, 'README.md');
      expect(resolved).toBe(path.resolve(testDir, 'README.md'));
    });

    it('should resolve nested paths correctly', () => {
      const resolved = validatePath(testDir, 'subdir/notes.txt');
      expect(resolved).toBe(path.resolve(testDir, 'subdir/notes.txt'));
    });

    it('should reject path traversal attempts', () => {
      expect(() => validatePath(testDir, '../etc/passwd')).toThrow();
    });

    it('should resolve symlinks and reject if outside root', () => {
      // Create a symlink inside testDir pointing outside
      const symlinkPath = path.join(testDir, 'escape-link');
      fs.symlinkSync('/etc', symlinkPath);
      expect(() => validatePath(testDir, 'escape-link/passwd')).toThrow();
    });
  });
});
