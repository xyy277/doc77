/**
 * T1 验收测试 — 同步引擎核心修复
 *
 * 覆盖验收标准：
 * 1. 临时目录放 2 个文件 → sync() → result.pushed === 2（local 适配器）
 * 2. testConnection() 对 webdav/s3/local 不崩溃
 * 3. git 适配器回归通过（不破坏 git.status() 自发现路径）
 *
 * 测试范式参考 packages/core/__tests__/crypto.test.ts：
 * - 临时目录 + 真实文件系统操作
 * - 直接调用 SyncEngine 实例方法
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { SyncEngine } from '../src/engine.js';
import { scanLocal, compareRemote, shouldIgnore } from '../src/state.js';
import type { SyncConfig } from '../src/types.js';

/** 创建临时目录 */
function makeTmp(prefix: string): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `doc77-t1-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  );
}

/** 递归删除目录（容错） */
function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('SyncEngine — local adapter', () => {
  let srcDir: string;
  let dstDir: string;

  beforeEach(() => {
    srcDir = makeTmp('src');
    dstDir = makeTmp('dst');
  });

  afterEach(() => {
    rmTmp(srcDir);
    rmTmp(dstDir);
  });

  it('sync() 推送 2 个新文件到目标目录 → pushed === 2', async () => {
    // 在源目录创建 2 个文件
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello A');
    fs.writeFileSync(path.join(srcDir, 'b.md'), '# B\nhello B');

    const config: SyncConfig = {
      project_id: 1,
      adapter_type: 'local',
      config_json: JSON.stringify({
        type: 'local',
        targetPath: dstDir,
        mirror: false,
        ignorePatterns: ['node_modules/', '.git/', '*.tmp'],
      }),
      direction: 'push',
      interval_seconds: 0,
      enabled: 1,
    };

    const engine = new SyncEngine();
    const result = await engine.sync(1, srcDir, config);

    expect(result.status).toBe('success');
    expect(result.pushed).toBe(2);
    // 验证文件确实被复制
    expect(fs.existsSync(path.join(dstDir, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, 'b.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dstDir, 'a.txt'), 'utf8')).toBe('hello A');
    expect(fs.readFileSync(path.join(dstDir, 'b.md'), 'utf8')).toBe('# B\nhello B');
  });

  it('sync() 第二次推送无变更 → pushed === 0（按 mtime 跳过）', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello A');

    const config: SyncConfig = {
      project_id: 1,
      adapter_type: 'local',
      config_json: JSON.stringify({
        type: 'local',
        targetPath: dstDir,
        mirror: false,
        ignorePatterns: [],
      }),
      direction: 'push',
      interval_seconds: 0,
      enabled: 1,
    };

    const engine = new SyncEngine();
    const r1 = await engine.sync(1, srcDir, config);
    expect(r1.pushed).toBe(1);

    // 第二次：目标已有同名文件且 mtime 更新（复制时间晚于源文件创建时间）
    const r2 = await engine.sync(1, srcDir, config);
    expect(r2.pushed).toBe(0);
  });

  it('sync() 双向模式 pull 远端新增文件', async () => {
    // 目标目录预先放一个文件（模拟远端已有）
    fs.writeFileSync(path.join(dstDir, 'remote-only.txt'), 'from remote');

    const config: SyncConfig = {
      project_id: 1,
      adapter_type: 'local',
      config_json: JSON.stringify({
        type: 'local',
        targetPath: dstDir,
        mirror: false,
        ignorePatterns: [],
      }),
      direction: 'pull',
      interval_seconds: 0,
      enabled: 1,
    };

    const engine = new SyncEngine();
    const result = await engine.sync(1, srcDir, config);

    expect(result.status).toBe('success');
    expect(result.pulled).toBe(1);
    expect(fs.existsSync(path.join(srcDir, 'remote-only.txt'))).toBe(true);
  });
});

describe('SyncEngine — testConnection 不崩溃', () => {
  it('local testConnection 对存在的目录返回 ok', async () => {
    const dir = makeTmp('tc-local');
    try {
      const engine = new SyncEngine();
      const result = await engine.testConnection(
        'local',
        JSON.stringify({
          type: 'local',
          targetPath: dir,
          mirror: false,
          ignorePatterns: [],
        }),
      );
      expect(result.ok).toBe(true);
    } finally {
      rmTmp(dir);
    }
  });

  it('webdav testConnection 对无效端点返回 !ok（不崩溃）', async () => {
    const engine = new SyncEngine();
    const result = await engine.testConnection(
      'webdav',
      JSON.stringify({
        type: 'webdav',
        endpoint: 'http://127.0.0.1:9', // 不可达端口
        username: 'u',
        password: 'p',
        remotePath: '/',
        ignorePatterns: [],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('s3 testConnection 对无效凭证返回 !ok（不崩溃）', async () => {
    const engine = new SyncEngine();
    const result = await engine.testConnection(
      's3',
      JSON.stringify({
        type: 's3',
        region: 'us-east-1',
        bucket: 'doc77-nonexistent-bucket-test',
        prefix: '',
        accessKeyId: 'AKIATESTINVALID',
        secretAccessKey: 'secrettestinvalid',
        ignorePatterns: [],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('未知适配器类型返回 !ok', async () => {
    const engine = new SyncEngine();
    const result = await engine.testConnection('unknown-type', '{}');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unknown adapter');
  });
});

describe('SyncEngine — git 适配器回归', () => {
  let gitSrc: string;
  let bareRemote: string;

  beforeEach(() => {
    gitSrc = makeTmp('git-src');
    bareRemote = makeTmp('git-bare');
  });

  afterEach(() => {
    rmTmp(gitSrc);
    rmTmp(bareRemote);
  });

  /**
   * git 适配器用 git.status() 自发现变更，不依赖 ctx.changedFiles
   * 此测试验证 engine 修改后 git 路径仍可用：
   * 1. adapterConfig 字段对 git 适配器无害
   * 2. git.status() 自发现变更路径未被破坏
   */
  it('git push 提交并推送到本地 bare 仓库', async () => {
    // 初始化 bare 远程仓库
    execSync('git init --bare', { cwd: bareRemote });

    // 初始化源仓库
    execSync('git init', { cwd: gitSrc });
    execSync('git config user.email test@doc77.local', { cwd: gitSrc });
    execSync('git config user.name Doc77Test', { cwd: gitSrc });
    execSync('git checkout -b main', { cwd: gitSrc });
    execSync(`git remote add origin "${bareRemote}"`, { cwd: gitSrc });

    // 初始提交
    fs.writeFileSync(path.join(gitSrc, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: gitSrc });
    execSync('git commit -m "init"', { cwd: gitSrc });
    execSync('git push -u origin main', { cwd: gitSrc });

    // 新增一个文件（git.status 应发现）
    fs.writeFileSync(path.join(gitSrc, 'new-file.md'), '# New File');

    const config: SyncConfig = {
      project_id: 1,
      adapter_type: 'git',
      config_json: JSON.stringify({
        type: 'git',
        remoteUrl: bareRemote,
        branch: 'main',
        remoteName: 'origin',
        authMethod: 'https',
        commitPrefix: '[doc77-sync]',
        autoCommit: true,
        pullStrategy: 'merge',
        ignorePatterns: [],
      }),
      direction: 'push',
      interval_seconds: 0,
      enabled: 1,
    };

    const engine = new SyncEngine();
    const result = await engine.sync(1, gitSrc, config);

    // git.status() 发现 1 个新文件 → commit + push
    expect(result.pushed).toBe(1);
    expect(result.status).toBe('success');
    expect(result.errors).toHaveLength(0);
  });
});

describe('state.ts — scanLocal + compareRemote', () => {
  it('scanLocal 返回目录下所有文件', () => {
    const dir = makeTmp('scan');
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B');
      // 应被忽略
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.writeFileSync(path.join(dir, 'node_modules', 'lib.js'), 'C');

      const changes = scanLocal(dir, ['node_modules/', '.git/', '*.tmp']);
      const paths = changes.map((c) => c.path).sort();
      expect(paths).toEqual(['a.txt', 'sub/b.txt']);
    } finally {
      rmTmp(dir);
    }
  });

  it('shouldIgnore 匹配模式', () => {
    expect(shouldIgnore('node_modules/foo.js', ['node_modules/'])).toBe(true);
    expect(shouldIgnore('foo.tmp', ['*.tmp'])).toBe(true);
    expect(shouldIgnore('a/b.txt', ['*.tmp'])).toBe(false);
    expect(shouldIgnore('README.md', ['node_modules/'])).toBe(false);
  });

  it('compareRemote 本地有远程无 → toPush', () => {
    const local = [
      { path: 'a.txt', type: 'added' as const, mtime: '2026-01-01T00:00:00.000Z', hash: 'h1', size: 1 },
      { path: 'b.txt', type: 'added' as const, mtime: '2026-01-01T00:00:00.000Z', hash: 'h2', size: 1 },
    ];
    const remote = [{ path: 'c.txt', size: 1, lastModified: '2026-01-01T00:00:00.000Z' }];

    const diff = compareRemote(local, remote);
    expect(diff.toPush).toHaveLength(2);
    expect(diff.toPull).toHaveLength(1);
    expect(diff.toPull[0].path).toBe('c.txt');
    expect(diff.conflicts).toHaveLength(0);
  });

  it('compareRemote hash 相同 → 跳过', () => {
    const local = [
      { path: 'a.txt', type: 'added' as const, mtime: '2026-01-01T00:00:00.000Z', hash: 'same', size: 1 },
    ];
    const remote = [
      { path: 'a.txt', size: 1, lastModified: '2026-01-01T00:00:00.000Z', hash: 'same' },
    ];
    const diff = compareRemote(local, remote);
    expect(diff.toPush).toHaveLength(0);
    expect(diff.toPull).toHaveLength(0);
    expect(diff.conflicts).toHaveLength(0);
  });

  it('compareRemote hash 不同 → toPush + conflicts', () => {
    const local = [
      { path: 'a.txt', type: 'added' as const, mtime: '2026-01-01T00:00:00.000Z', hash: 'local-hash', size: 1 },
    ];
    const remote = [
      { path: 'a.txt', size: 1, lastModified: '2026-01-01T00:00:00.000Z', hash: 'remote-hash' },
    ];
    const diff = compareRemote(local, remote);
    expect(diff.toPush).toHaveLength(1);
    expect(diff.toPush[0].type).toBe('modified');
    expect(diff.conflicts).toHaveLength(1);
    expect(diff.conflicts[0].localHash).toBe('local-hash');
    expect(diff.conflicts[0].remoteHash).toBe('remote-hash');
  });
});
