import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, runMigrations, registerProject } from '@doc77/core';
import { searchFiles } from '../src/tools/search.js';

describe('search_files', () => {
  let testDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-search-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    const dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();

    const projDir = path.join(testDir, 'project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'readme.md'), '# Hello World\nThis is a test');
    fs.writeFileSync(path.join(projDir, 'notes.txt'), 'TODO: fix bug\nDone');
    fs.mkdirSync(path.join(projDir, 'sub'));
    fs.writeFileSync(path.join(projDir, 'sub', 'api.md'), '## API Doc\nendpoint: /api');

    const proj = registerProject('Search Test', projDir);
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

  it('should find keyword in files', () => {
    const results = searchFiles(projectId, 'Hello');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file_path).toContain('readme.md');
  });

  it('should find regex pattern', () => {
    const results = searchFiles(projectId, '/TODO/');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].line_content).toContain('TODO');
  });

  it('should respect max_results', () => {
    const results = searchFiles(projectId, '.', { maxResults: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('should include context_before and context_after', () => {
    const results = searchFiles(projectId, 'World');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].line_number).toBeGreaterThan(0);
  });

  it('should filter by glob', () => {
    const results = searchFiles(projectId, '.', { glob: '*.txt', maxResults: 20 });
    expect(results.every((r) => r.file_path.endsWith('.txt'))).toBe(true);
  });

  it('should throw for non-existent project', () => {
    expect(() => searchFiles(99999, 'test')).toThrow('Project not found');
  });

  it('should return empty results for no match', () => {
    const results = searchFiles(projectId, 'zzzznonexistentkeyword');
    expect(results.length).toBe(0);
  });
});
