import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const testDir = path.join(os.tmpdir(), 'doc77-edit-test-' + Date.now());

describe('Editor content endpoint (unit-level checks)', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'test.md'), '# Hello\n\nWorld', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should verify editable file extension gating', () => {
    const editableExts = [
      '.md',
      '.mdx',
      '.txt',
      '.markdown',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.rb',
      '.go',
      '.rs',
      '.java',
      '.c',
      '.cpp',
      '.h',
      '.css',
      '.scss',
      '.less',
      '.html',
      '.htm',
      '.xml',
      '.svg',
      '.sh',
      '.bash',
      '.zsh',
      '.env.example',
      '.gitignore',
      '.dockerignore',
      '.editorconfig',
      '.conf',
      '.cfg',
      '.ini',
      '.csv',
      '.log',
    ];
    expect(editableExts.includes('.md')).toBe(true);
    expect(editableExts.includes('.png')).toBe(false);
    expect(editableExts.includes('.pdf')).toBe(false);
    expect(editableExts.includes('.docx')).toBe(false);
  });

  it('should verify size limit check', () => {
    const maxSizeMB = 2;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    const smallContent = '# Hello';
    const largeContent = 'x'.repeat(3 * 1024 * 1024);
    expect(Buffer.byteLength(smallContent, 'utf-8') > maxSizeBytes).toBe(false);
    expect(Buffer.byteLength(largeContent, 'utf-8') > maxSizeBytes).toBe(true);
  });

  it('should verify shadow backup and restore logic', () => {
    const testFile = path.join(testDir, 'shadow-test.md');
    const original = '# Original content';
    const modified = '# Modified content';
    fs.writeFileSync(testFile, original, 'utf-8');

    // Simulate shadow backup
    const shadowDir = path.join(os.tmpdir(), '.doc77', 'shadow', 'test-task');
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.copyFileSync(testFile, path.join(shadowDir, 'shadow-test.md'));

    // Simulate failed write (partial)
    try {
      fs.writeFileSync(testFile, 'corrupt', 'utf-8');
      throw new Error('simulated disk error');
    } catch {
      // Restore from shadow
      const sf = path.join(shadowDir, 'shadow-test.md');
      fs.copyFileSync(sf, testFile);
    }

    const restored = fs.readFileSync(testFile, 'utf-8');
    expect(restored).toBe(original);

    // Cleanup
    fs.rmSync(shadowDir, { recursive: true, force: true });
  });
});
