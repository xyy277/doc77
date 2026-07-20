import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, runMigrations, registerProject } from '@doc77/core';
import { listProjects, getProjectInfo } from '../src/tools/discovery.js';

describe('Discovery Tools', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-discovery-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    const dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();

    const projDir = path.join(testDir, 'project-a');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'readme.md'), '# A');
    registerProject('Project A', projDir);
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('listProjects', () => {
    it('should return all registered projects', () => {
      const projects = listProjects();
      expect(projects.length).toBeGreaterThanOrEqual(1);
      expect(projects[0].name).toBe('Project A');
      expect(projects[0].path).toContain('project-a');
      expect(projects[0].file_count).toBeGreaterThanOrEqual(1);
      expect(projects[0].created_at).toBeDefined();
    });
  });

  describe('getProjectInfo', () => {
    it('should return project details', () => {
      const projects = listProjects();
      const info = getProjectInfo(projects[0].id);
      expect(info).not.toBeNull();
      expect(info!.name).toBe('Project A');
      expect(info!.file_count).toBeGreaterThanOrEqual(1);
      expect(info!.total_size).toBeGreaterThan(0);
    });

    it('should return null for invalid project ID', () => {
      expect(getProjectInfo(99999)).toBeNull();
    });
  });
});
