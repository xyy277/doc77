import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolveProjectPath } from '../src/fs/index.js';

describe('resolveProjectPath', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `doc77-resolve-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve ~ to home directory', () => {
    const result = resolveProjectPath('~/test-dir');
    expect(result).toBe(path.join(os.homedir(), 'test-dir'));
  });

  it('should resolve relative paths to absolute', () => {
    const cwd = process.cwd();
    const result = resolveProjectPath('./relative/path');
    expect(result).toBe(path.resolve(cwd, 'relative/path'));
  });

  it('should keep absolute Linux paths unchanged (after normalization)', () => {
    const input = path.join(testDir, 'my-project');
    fs.mkdirSync(input);
    const result = resolveProjectPath(input);
    expect(result).toBe(input);
  });

  it('should handle ~ with nested path', () => {
    const result = resolveProjectPath('~/work/docs/project');
    expect(result).toBe(path.join(os.homedir(), 'work/docs/project'));
  });
});
