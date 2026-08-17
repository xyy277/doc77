import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('resolveWikilink', () => {
  let tmpDir: string;
  let projectRoot: string;
  const projectId = 1;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-wikilink-test-'));
    projectRoot = path.join(tmpDir, 'vault');
    fs.mkdirSync(projectRoot, { recursive: true });
    // Create test files
    fs.writeFileSync(path.join(projectRoot, 'Note A.md'), '# Note A');
    fs.writeFileSync(path.join(projectRoot, 'NOTE_A.md'), '# NOTE A uppercase');
    fs.mkdirSync(path.join(projectRoot, 'subfolder'));
    fs.writeFileSync(path.join(projectRoot, 'subfolder', 'Deep Note.md'), '# Deep');
  });

  afterEach(async () => {
    // Clear the project cache so it doesn't leak between tests
    const { clearWikilinkCache } = await import('./wikilink.js');
    clearWikilinkCache(projectId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should export resolveWikilink as a function', async () => {
    const { resolveWikilink } = await import('./wikilink.js');
    expect(typeof resolveWikilink).toBe('function');
  });

  it('should export clearWikilinkCache as a function', async () => {
    const { clearWikilinkCache } = await import('./wikilink.js');
    expect(typeof clearWikilinkCache).toBe('function');
  });

  it('should find exact match for a note in root', async () => {
    const { resolveWikilink } = await import('./wikilink.js');
    const result = resolveWikilink('Note A', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'Note A.md'));
  });

  it('should find exact match with .md suffix in title', async () => {
    const { resolveWikilink } = await import('./wikilink.js');
    const result = resolveWikilink('Note A.md', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'Note A.md'));
  });

  it('should find a file via case-insensitive match', async () => {
    const { resolveWikilink } = await import('./wikilink.js');
    // File is 'NOTE_A.md', title is 'note_a' — differs only in case
    const result = resolveWikilink('note_a', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'NOTE_A.md'));
  });

  it('should find a file in subfolder', async () => {
    const { resolveWikilink } = await import('./wikilink.js');
    const result = resolveWikilink('Deep Note', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'subfolder', 'Deep Note.md'));
  });

  it('should return null for non-existent note (dead link)', async () => {
    const { resolveWikilink } = await import('./wikilink.js');
    const result = resolveWikilink('NonExistent', projectId, projectRoot);
    expect(result).toBeNull();
  });

  it('should resolve via alias map in .doc77links', async () => {
    const { resolveWikilink, clearWikilinkCache } = await import('./wikilink.js');
    // Create .doc77links file with alias
    fs.writeFileSync(path.join(projectRoot, '.doc77links'), '# Aliases\nShortcut → Note A.md\n');
    // Clear cache so it picks up new files
    clearWikilinkCache(projectId);
    const result = resolveWikilink('Shortcut', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'Note A.md'));
  });

  it('should resolve via alias map with = separator', async () => {
    const { resolveWikilink, clearWikilinkCache } = await import('./wikilink.js');
    fs.writeFileSync(path.join(projectRoot, '.doc77links'), 'Shortcut = Note A.md\n');
    clearWikilinkCache(projectId);
    const result = resolveWikilink('Shortcut', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'Note A.md'));
  });

  it('should ignore comments and blank lines in .doc77links', async () => {
    const { resolveWikilink, clearWikilinkCache } = await import('./wikilink.js');
    fs.writeFileSync(
      path.join(projectRoot, '.doc77links'),
      '# This is a comment\n\nAlias → Note A.md\n',
    );
    clearWikilinkCache(projectId);
    const result = resolveWikilink('Alias', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'Note A.md'));
  });
});

describe('clearWikilinkCache', () => {
  let tmpDir: string;
  let projectRoot: string;
  const projectId = 1;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-cache-test-'));
    projectRoot = path.join(tmpDir, 'vault');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'test.md'), '# test');
  });

  afterEach(async () => {
    const { clearWikilinkCache } = await import('./wikilink.js');
    clearWikilinkCache(projectId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should clear cache for a specific project', async () => {
    const { resolveWikilink, clearWikilinkCache } = await import('./wikilink.js');
    // First call populates cache
    resolveWikilink('test', projectId, projectRoot);
    // Create a new file
    fs.writeFileSync(path.join(projectRoot, 'new.md'), '# new');
    // Clear cache for this project
    clearWikilinkCache(projectId);
    // Should find the new file now
    const result = resolveWikilink('new', projectId, projectRoot);
    expect(result).toBe(path.join(projectRoot, 'new.md'));
  });

  it('should clear all cache when no projectId given', async () => {
    const { clearWikilinkCache } = await import('./wikilink.js');
    // Just verify it doesn't throw
    expect(() => clearWikilinkCache()).not.toThrow();
  });
});

describe('createWikilinkIndex（红队索引化）', () => {
  let tmpDir: string;
  let projectRoot: string;
  const projectId = 1;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-wikilink-idx-'));
    projectRoot = path.join(tmpDir, 'vault');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'Note A.md'), '# Note A');
    fs.writeFileSync(path.join(projectRoot, 'NOTE_A.md'), '# NOTE A uppercase');
    fs.mkdirSync(path.join(projectRoot, 'subfolder'));
    fs.writeFileSync(path.join(projectRoot, 'subfolder', 'Deep Note.md'), '# Deep');
    fs.writeFileSync(path.join(projectRoot, '.doc77links'), 'Shortcut → Note A.md\n');
  });

  afterEach(async () => {
    const { clearWikilinkCache } = await import('./wikilink.js');
    clearWikilinkCache(projectId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('与 resolveWikilinkIn 线性实现结果对等（exact/ci/alias/dead）', async () => {
    const { getProjectFiles, loadAliasMap, createWikilinkIndex, resolveWikilinkIn } =
      await import('./wikilink.js');
    const files = getProjectFiles(projectId, projectRoot);
    const aliasMap = loadAliasMap(projectRoot);
    const idx = createWikilinkIndex(files, aliasMap, projectRoot);
    for (const title of ['Note A', 'note_a', 'Deep Note', 'Shortcut', 'NonExistent', 'Note A.md']) {
      expect(idx.resolve(title)).toBe(resolveWikilinkIn(files, aliasMap, projectRoot, title));
    }
  });

  it('has()：全文件集合 O(1) 存在性检查', async () => {
    const { getProjectFiles, loadAliasMap, createWikilinkIndex } = await import('./wikilink.js');
    const idx = createWikilinkIndex(
      getProjectFiles(projectId, projectRoot),
      loadAliasMap(projectRoot),
      projectRoot,
    );
    expect(idx.has(path.join(projectRoot, 'Note A.md'))).toBe(true);
    expect(idx.has(path.join(projectRoot, 'missing.md'))).toBe(false);
  });
});

describe('updateFileListCache + 别名缓存 mtime 失效（红队）', () => {
  let tmpDir: string;
  let projectRoot: string;
  const projectId = 2;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-wikilink-upd-'));
    projectRoot = path.join(tmpDir, 'vault');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'a.md'), '# a');
  });

  afterEach(async () => {
    const { clearWikilinkCache } = await import('./wikilink.js');
    clearWikilinkCache(projectId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updateFileListCache 添加后无需整清即可解析新文件', async () => {
    const { resolveWikilink, updateFileListCache } = await import('./wikilink.js');
    // 预热缓存（此时无 b.md）
    expect(resolveWikilink('b', projectId, projectRoot)).toBeNull();
    // 新建文件 + 原地更新缓存（模拟保存路由挂点）
    const bAbs = path.join(projectRoot, 'b.md');
    fs.writeFileSync(bAbs, '# b');
    updateFileListCache(projectId, { added: [bAbs] });
    expect(resolveWikilink('b', projectId, projectRoot)).toBe(bAbs);
  });

  it('updateFileListCache 删除后解析为死链', async () => {
    const { resolveWikilink, updateFileListCache } = await import('./wikilink.js');
    const aAbs = path.join(projectRoot, 'a.md');
    expect(resolveWikilink('a', projectId, projectRoot)).toBe(aAbs);
    fs.rmSync(aAbs);
    updateFileListCache(projectId, { removed: [aAbs] });
    expect(resolveWikilink('a', projectId, projectRoot)).toBeNull();
  });

  it('别名缓存按 mtime 失效：改 .doc77links 不 clear 也生效', async () => {
    const { resolveWikilink, clearWikilinkCache } = await import('./wikilink.js');
    fs.writeFileSync(path.join(projectRoot, '.doc77links'), 'A1 → a.md\n');
    clearWikilinkCache(projectId); // 预热文件列表
    expect(resolveWikilink('A1', projectId, projectRoot)).toBe(path.join(projectRoot, 'a.md'));
    // 直接改别名文件（不 clear）→ mtime 变化 → 自动重新读盘
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(projectRoot, '.doc77links'), 'A2 → a.md\n');
    expect(resolveWikilink('A2', projectId, projectRoot)).toBe(path.join(projectRoot, 'a.md'));
    expect(resolveWikilink('A1', projectId, projectRoot)).toBeNull();
  });
});
