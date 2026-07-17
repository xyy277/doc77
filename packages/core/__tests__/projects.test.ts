import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject, listProjects, removeProject, updateProject } from '../src/db/projects.js';

describe('Project CRUD', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-proj-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');

    // Create a fake project directory
    projectDir = path.join(testDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Test');

    await initDatabase(dbPath);
    runMigrations();
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('registerProject', () => {
    it('should register a new project', () => {
      const project = registerProject('Test Project', projectDir);
      expect(project).toBeDefined();
      expect(project.id).toBeGreaterThan(0);
      expect(project.name).toBe('Test Project');
      expect(project.path).toBe(projectDir);
      expect(project.created_at).toBeDefined();
    });

    it('should reject duplicate project paths', () => {
      registerProject('First', projectDir);
      expect(() => registerProject('Second', projectDir)).toThrow();
    });
  });

  describe('listProjects', () => {
    it('should return empty array when no projects', () => {
      const projects = listProjects();
      expect(projects).toEqual([]);
    });

    it('should return all registered projects', () => {
      registerProject('A', projectDir);
      const dir2 = path.join(testDir, 'project-b');
      fs.mkdirSync(dir2);
      registerProject('B', dir2);

      const projects = listProjects();
      expect(projects).toHaveLength(2);
      expect(projects.map((p) => p.name).sort()).toEqual(['A', 'B']);
    });

    it('should include all fields', () => {
      registerProject('Full', projectDir);
      const projects = listProjects();
      const p = projects[0];
      expect(p.id).toBeGreaterThan(0);
      expect(p.name).toBe('Full');
      expect(p.path).toBe(projectDir);
      expect(p.created_at).toBeDefined();
    });
  });

  describe('removeProject', () => {
    it('should remove a project by id', () => {
      const p = registerProject('ToRemove', projectDir);
      const result = removeProject(p.id);
      expect(result).toBe(true);
      expect(listProjects()).toHaveLength(0);
    });

    it('should return false for non-existent id', () => {
      const result = removeProject(99999);
      expect(result).toBe(false);
    });
  });

  describe('updateProject', () => {
    it('should update project name', () => {
      const p = registerProject('Old Name', projectDir);
      updateProject(p.id, { name: 'New Name' });
      const projects = listProjects();
      expect(projects[0].name).toBe('New Name');
    });

    it('should update project path', () => {
      const p = registerProject('Path Test', projectDir);
      const newDir = path.join(testDir, 'moved-project');
      fs.mkdirSync(newDir);
      updateProject(p.id, { path: newDir });
      const projects = listProjects();
      expect(projects[0].path).toBe(newDir);
    });

    it('should update both name and path', () => {
      const p = registerProject('Original', projectDir);
      const newDir = path.join(testDir, 'renamed');
      fs.mkdirSync(newDir);
      updateProject(p.id, { name: 'Renamed', path: newDir });
      const projects = listProjects();
      expect(projects[0].name).toBe('Renamed');
      expect(projects[0].path).toBe(newDir);
    });
  });

  describe('obsidian_mode', () => {
    it('should default obsidian_mode to false', () => {
      const p = registerProject('Normal', projectDir);
      expect(p.obsidian_mode).toBe(false);
    });

    it('should register project with obsidianMode enabled', () => {
      const p = registerProject('Vault', projectDir, true);
      expect(p.obsidian_mode).toBe(true);
    });

    it('should update obsidian_mode', () => {
      const p = registerProject('Toggle', projectDir);
      updateProject(p.id, { obsidian_mode: true });
      const projects = listProjects();
      const updated = projects.find(pr => pr.id === p.id);
      expect(updated?.obsidian_mode).toBe(true);
    });
  });

  describe('tags', () => {
    it('should default to empty array', () => {
      const p = registerProject('NoTags', projectDir);
      expect(p.tags).toEqual([]);
    });
    it('should register with tags', () => {
      const p = registerProject('Tagged', projectDir, false, ['nodejs', 'git']);
      expect(p.tags).toEqual(['nodejs', 'git']);
    });
    it('should update tags', () => {
      const p = registerProject('TagUpdate', projectDir);
      updateProject(p.id, { tags: ['python'] });
      const updated = listProjects().find(pr => pr.id === p.id);
      expect(updated?.tags).toEqual(['python']);
    });
  });
});
