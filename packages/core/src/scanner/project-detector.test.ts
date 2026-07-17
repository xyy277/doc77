import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectProjectTags, discoverGitProjects, parseCodeWorkspace } from './project-detector.js';

describe('detectProjectTags', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should detect nodejs from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    expect(detectProjectTags(tmpDir)).toContain('nodejs');
  });

  it('should detect typescript from tsconfig.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    expect(detectProjectTags(tmpDir)).toContain('typescript');
  });

  it('should detect python from requirements.txt', () => {
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '');
    expect(detectProjectTags(tmpDir)).toContain('python');
  });

  it('should detect go from go.mod', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), '');
    expect(detectProjectTags(tmpDir)).toContain('go');
  });

  it('should detect rust from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '');
    expect(detectProjectTags(tmpDir)).toContain('rust');
  });

  it('should detect git from .git directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    expect(detectProjectTags(tmpDir)).toContain('git');
  });

  it('should detect multiple tags', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    const tags = detectProjectTags(tmpDir);
    expect(tags).toContain('nodejs');
    expect(tags).toContain('typescript');
    expect(tags).toContain('git');
  });

  it('should return empty array for empty dir', () => {
    expect(detectProjectTags(tmpDir)).toEqual([]);
  });
});

describe('discoverGitProjects', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-git-'));
    fs.mkdirSync(path.join(tmpDir, 'repo1', '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'repo1', 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'repo2', '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'repo2', 'requirements.txt'), '');
    fs.mkdirSync(path.join(tmpDir, 'not-repo'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find git repositories', () => {
    const results = discoverGitProjects(tmpDir, 2);
    expect(results.length).toBe(2);
  });

  it('should detect tags for git repos', () => {
    const results = discoverGitProjects(tmpDir, 2);
    const repo1 = results.find(r => r.name === 'repo1');
    expect(repo1?.tags).toContain('nodejs');
    expect(repo1?.tags).toContain('git');
  });
});

describe('parseCodeWorkspace', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-ws-'));
    fs.mkdirSync(path.join(tmpDir, 'packages', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should parse workspace folders', () => {
    const wsPath = path.join(tmpDir, 'test.code-workspace');
    fs.writeFileSync(wsPath, JSON.stringify({
      folders: [
        { path: 'packages/core' },
        { path: 'lib', name: 'Shared Lib' },
      ],
    }));
    const results = parseCodeWorkspace(wsPath);
    expect(results.length).toBe(2);
    expect(results[1].name).toBe('Shared Lib');
    expect(results[1].path).toBe(path.join(tmpDir, 'lib'));
  });

  it('should return empty array for invalid JSON', () => {
    const wsPath = path.join(tmpDir, 'bad.code-workspace');
    fs.writeFileSync(wsPath, 'not json');
    expect(parseCodeWorkspace(wsPath)).toEqual([]);
  });

  it('should return empty array for missing file', () => {
    expect(parseCodeWorkspace('/nonexistent/code-workspace')).toEqual([]);
  });
});
