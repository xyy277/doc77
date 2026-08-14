import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
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
} from '../src/server/watcher.js';
import { getEventBus, resetEventBus } from '../src/server/event-bus.js';

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
describe('file watcher', () => {
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

  function waitForEvent(
    predicate: (p: TreeChangedPayload) => boolean,
    timeoutMs = 5000,
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
    expect(payload.path).toBe('docs');
    expect(payload.paths).toContain('docs/api.md');
  });
});
