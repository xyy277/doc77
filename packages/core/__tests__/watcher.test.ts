import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, flushDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';
import { scanDirectory } from '../src/scanner/index.js';
import {
  startFileWatcher,
  stopFileWatcher,
  watchProject,
  stopWatching,
  isWatcherRunning,
  watcherReady,
  acquireWatcherRef,
  releaseWatcherRef,
} from '../src/server/watcher.js';
import { getEventBus, resetEventBus } from '../src/server/event-bus.js';

// node:fs 内置模块属性不可 redefine（spyOn 报错），模块级 mock 包装
// writeFileSync 用于断言"watcher flush 不再触发 DB 落盘"（其余透传）
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

interface TreeChangedPayload {
  projectId: number;
  path: string;
  opType: string;
  paths: string[];
  truncated?: boolean;
}

/**
 * 文件系统监听器 — 磁盘变化 → file-tree:changed 事件 → 缓存失效
 *
 * 使用真实临时目录（CI 安全），验证：
 *   1. 事件映射（create/modify/delete）与项目归属
 *   2. 事件触发后 filetree_cache 失效（scanDirectory 返回 cached: false）
 *   3. 同目录变更去抖合并（git pull 批量文件不产生事件风暴）
 *   4. watchProject / stopWatching 动态增删监听
 */
// macOS arm64 CI runner 上 fs.watch recursive 对新文件事件存在偶发丢失
// （每次仅个别用例超时、随机分布，Linux/Windows 稳定）——watcher 是
// 尽力而为组件，产品端事件丢失降级为手动刷新。用重试防平台 flaky：
// 失败用例独立重跑，系统性回归时重试后仍失败、如实报红，不会掩盖问题。
describe.retry(2)('file watcher', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `doc77-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello');

    await initDatabase(dbPath);
    runMigrations();
    resetEventBus();
  });

  afterEach(async () => {
    stopFileWatcher();
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // macOS 上 chokidar v4 走 fs.watch（recursive）事件有平台延迟（CI macOS
  // runner 实测偶发 >5s），默认超时放宽到 15s 防 flaky —— watcher 本身
  // 是尽力而为组件，事件延迟不构成产品缺陷
  function waitForEvent(
    predicate: (p: TreeChangedPayload) => boolean,
    timeoutMs = 15000,
  ): Promise<TreeChangedPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bus.off('file-tree:changed', listener);
        reject(new Error('timed out waiting for file-tree:changed event'));
      }, timeoutMs);
      const bus = getEventBus();
      const listener = (p: unknown) => {
        const payload = p as TreeChangedPayload;
        if (predicate(payload)) {
          clearTimeout(timer);
          bus.off('file-tree:changed', listener);
          resolve(payload);
        }
      };
      bus.on('file-tree:changed', listener);
    });
  }

  function collectEvents(
    predicate: (p: TreeChangedPayload) => boolean,
    durationMs: number,
  ): Promise<TreeChangedPayload[]> {
    const events: TreeChangedPayload[] = [];
    const bus = getEventBus();
    const listener = (p: unknown) => {
      const payload = p as TreeChangedPayload;
      if (predicate(payload)) events.push(payload);
    };
    bus.on('file-tree:changed', listener);
    return new Promise((resolve) => {
      setTimeout(() => {
        bus.off('file-tree:changed', listener);
        resolve(events);
      }, durationMs);
    });
  }

  it('start/stop 生命周期与项目归属映射', async () => {
    const p = registerProject('WatcherLifecycle', projectDir);
    startFileWatcher({ debounceMs: 50 });
    expect(isWatcherRunning()).toBe(true);
    await watcherReady();

    const eventPromise = waitForEvent((x) => x.projectId === p.id);
    fs.writeFileSync(path.join(projectDir, 'new-file.md'), 'hi');
    const payload = await eventPromise;
    expect(payload.path).toBe('');
    expect(payload.opType).toBe('create');
    expect(payload.paths).toContain('new-file.md');

    stopFileWatcher();
    expect(isWatcherRunning()).toBe(false);
  });

  it('事件触发后目录缓存失效（scanDirectory 返回 cached: false）', async () => {
    const p = registerProject('WatcherCache', projectDir);
    startFileWatcher({ debounceMs: 50 });
    await watcherReady();

    // 先扫一次，命中缓存
    scanDirectory(p.id, '');
    const cached = scanDirectory(p.id, '');

    const eventPromise = waitForEvent((x) => x.projectId === p.id);
    fs.writeFileSync(path.join(projectDir, 'cached-check.md'), 'x');
    await eventPromise;
    const fresh = scanDirectory(p.id, '');
    expect(cached.cached).toBe(true);
    expect(fresh.cached).toBe(false);
  });

  it('同目录批量变更去抖合并（不产生事件风暴）', async () => {
    const p = registerProject('WatcherMerge', projectDir);
    startFileWatcher({ debounceMs: 400 });
    await watcherReady();

    const collecting = collectEvents((x) => x.projectId === p.id, 1200);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(projectDir, `bulk-${i}.md`), 'x');
    }
    const events = await collecting;
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(2); // 400ms 去抖窗口合并
    const allPaths = events.flatMap((e) => e.paths);
    for (let i = 0; i < 5; i++) expect(allPaths).toContain(`bulk-${i}.md`);
  });

  it('watchProject / stopWatching 动态增删监听', async () => {
    const p1 = registerProject('WatcherDynamic1', projectDir);
    startFileWatcher({ debounceMs: 50 });
    await watcherReady();

    const dir2 = path.join(testDir, 'project2');
    fs.mkdirSync(dir2, { recursive: true });
    const p2 = registerProject('WatcherDynamic2', dir2);
    watchProject(p2.id);
    // 动态 add 后无 ready 信号，等待底层 watcher 挂载
    await new Promise((r) => setTimeout(r, 250));

    // 两个项目都能收到事件
    const ev1 = waitForEvent((x) => x.projectId === p1.id);
    const ev2 = waitForEvent((x) => x.projectId === p2.id);
    fs.writeFileSync(path.join(projectDir, 'one.md'), 'x');
    fs.writeFileSync(path.join(dir2, 'two.md'), 'x');
    await ev1;
    await ev2;

    // 停止监听 p2 后不再收到事件
    stopWatching(p2.id);
    let sawP2 = false;
    const bus = getEventBus();
    const spy = (payload: unknown) => {
      if ((payload as TreeChangedPayload).projectId === p2.id) sawP2 = true;
    };
    bus.on('file-tree:changed', spy);
    fs.writeFileSync(path.join(dir2, 'three.md'), 'x');
    await new Promise((r) => setTimeout(r, 300));
    bus.off('file-tree:changed', spy);
    expect(sawP2).toBe(false);
  });

  it('外部目录变更（子目录文件）→ 事件 path 为相对目录', async () => {
    const p = registerProject('WatcherSubdir', projectDir);
    fs.mkdirSync(path.join(projectDir, 'docs'));
    startFileWatcher({ debounceMs: 50 });
    await watcherReady();

    const eventPromise = waitForEvent((x) => x.projectId === p.id);
    fs.writeFileSync(path.join(projectDir, 'docs', 'api.md'), '## API');
    const payload = await eventPromise;
    // Linux/Windows 报精确相对路径（path='docs'，paths 含 'docs/api.md'）；
    // macOS 上 fs.watch recursive 对子目录写入可能只报目录级事件（path=''，
    // paths 为 'docs'）。watcher 是尽力而为组件，粒度差异非缺陷——
    // 断言只要求事件归属正确且 paths 命中 docs 前缀
    if (payload.path) {
      expect(payload.path).toBe('docs');
    }
    expect(payload.paths.some((p) => p === 'docs' || p.startsWith('docs/'))).toBe(true);
  });

  it('flush 不触发 DB 落盘（v1.1.4 缓存内存化 + 死写删除）', async () => {
    const p = registerProject('WatcherNoDbWrite', projectDir);
    // 结算注册项目产生的 DB 变更，之后开始计数
    flushDatabase();
    vi.mocked(fs.writeFileSync).mockClear();

    startFileWatcher({ debounceMs: 50 });
    await watcherReady();

    const eventPromise = waitForEvent((x) => x.projectId === p.id);
    fs.writeFileSync(path.join(projectDir, 'no-db-write.md'), 'x');
    await eventPromise;
    // 等去抖 flush 完成
    await new Promise((r) => setTimeout(r, 120));

    // 本次文件变更链路（watcher → clearCache → SSE）不得产生任何 DB 落盘
    const dbWrites = vi
      .mocked(fs.writeFileSync)
      .mock.calls.filter(([file]) => String(file).startsWith(dbPath));
    expect(dbWrites).toHaveLength(0);
  });

  it('惰性启停：首个 acquire 才启动，引用归零后延迟停止', async () => {
    registerProject('WatcherLazy', projectDir);
    expect(isWatcherRunning()).toBe(false);

    acquireWatcherRef();
    expect(isWatcherRunning()).toBe(true);
    await watcherReady();

    releaseWatcherRef({ idleStopMs: 30 });
    // 延迟停止窗口内仍在运行（防页面 reload 翻覆）
    expect(isWatcherRunning()).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(isWatcherRunning()).toBe(false);
  });

  it('引用翻覆防抖：停止窗口内重新 acquire 不重启 watcher', async () => {
    registerProject('WatcherFlap', projectDir);
    acquireWatcherRef();
    await watcherReady();

    releaseWatcherRef({ idleStopMs: 80 });
    await new Promise((r) => setTimeout(r, 30)); // 窗口内重新连接
    acquireWatcherRef();
    await new Promise((r) => setTimeout(r, 200)); // 超过原 idle 窗口
    expect(isWatcherRunning()).toBe(true); // 从未经历停止

    releaseWatcherRef({ idleStopMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    expect(isWatcherRunning()).toBe(false);
  });
});
