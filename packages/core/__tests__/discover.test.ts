import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverProjects } from '../src/scanner/discover.js';

const TEST_ROOT = path.join(os.tmpdir(), 'doc77-discover-test-' + Date.now());

beforeAll(() => {
  // Create a test directory structure
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // A valid project: has .git + .md
  const projA = path.join(TEST_ROOT, 'my-project');
  fs.mkdirSync(projA);
  fs.mkdirSync(path.join(projA, '.git'));
  fs.writeFileSync(path.join(projA, 'README.md'), '# Hello');

  // A project with .git but no .md files → should NOT be included
  const projB = path.join(TEST_ROOT, 'no-docs');
  fs.mkdirSync(projB);
  fs.mkdirSync(path.join(projB, '.git'));
  fs.writeFileSync(path.join(projB, 'main.js'), 'console.log(1)');

  // A directory with .md but no .git → should NOT be included
  const projC = path.join(TEST_ROOT, 'just-notes');
  fs.mkdirSync(projC);
  fs.writeFileSync(path.join(projC, 'notes.md'), '# Notes');

  // A hidden directory (starts with .) → should be skipped
  const hiddenDir = path.join(TEST_ROOT, '.config');
  fs.mkdirSync(hiddenDir);
  fs.mkdirSync(path.join(hiddenDir, '.git'));
  fs.writeFileSync(path.join(hiddenDir, 'README.md'), '# Config');

  // node_modules → should be skipped
  const nmDir = path.join(TEST_ROOT, 'node_modules');
  fs.mkdirSync(nmDir);
  fs.mkdirSync(path.join(nmDir, 'some-lib'));
  fs.mkdirSync(path.join(path.join(nmDir, 'some-lib'), '.git'));
  fs.writeFileSync(path.join(path.join(nmDir, 'some-lib'), 'README.md'), '# Lib');

  // __pycache__ → should be skipped
  const pyDir = path.join(TEST_ROOT, '__pycache__');
  fs.mkdirSync(pyDir);

  // Nested project (depth 2) → should be found with depth >= 2
  const nestedParent = path.join(TEST_ROOT, 'workspace');
  fs.mkdirSync(nestedParent);
  const nested = path.join(nestedParent, 'nested-project');
  fs.mkdirSync(nested);
  fs.mkdirSync(path.join(nested, '.git'));
  fs.writeFileSync(path.join(nested, 'README.md'), '# Nested');
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('discoverProjects', () => {
  it('finds valid projects (.git + >=1 .md)', () => {
    const results = discoverProjects(TEST_ROOT, 1, new Set());
    const names = results.map(r => r.name);
    expect(names).toContain('my-project');
    expect(names).not.toContain('no-docs');
    expect(names).not.toContain('just-notes');
  });

  it('skips hidden directories (starting with .)', () => {
    const results = discoverProjects(TEST_ROOT, 1, new Set());
    const names = results.map(r => r.name);
    expect(names).not.toContain('.config');
  });

  it('skips node_modules and __pycache__', () => {
    const results = discoverProjects(TEST_ROOT, 1, new Set());
    const names = results.map(r => r.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('__pycache__');
  });

  it('finds nested projects at depth 2', () => {
    const results = discoverProjects(TEST_ROOT, 2, new Set());
    const names = results.map(r => r.name);
    expect(names).toContain('nested-project');
  });

  it('returns hasReadme and mdCount correctly', () => {
    const results = discoverProjects(TEST_ROOT, 1, new Set());
    const proj = results.find(r => r.name === 'my-project');
    expect(proj).toBeTruthy();
    expect(proj!.hasReadme).toBe(true);
    expect(proj!.mdCount).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array for non-existent path', () => {
    const results = discoverProjects('/nonexistent/path/12345', 1, new Set());
    expect(results).toEqual([]);
  });

  it('stops at timeout (10s)', async () => {
    // This test verifies the timeout doesn't throw — for a small dir it completes fast
    const start = Date.now();
    const results = discoverProjects(TEST_ROOT, 2, new Set());
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10000);
    expect(Array.isArray(results)).toBe(true);
  });
});
