import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  initDatabase,
  closeConnection,
  getConnection,
  flushDatabase,
} from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';

// node:fs 内置模块属性不可 redefine（spyOn 报 Cannot redefine property），
// 用模块级 mock 包装 writeFileSync 计数（其余函数透传真实实现）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

/**
 * sql.js export 节流测试（v1.1.4 性能修复 Part 1-B）。
 *
 * 核心断言：连续写入时，整库序列化落盘频率必须被 MIN_PERSIST_INTERVAL_MS
 * cap 住（与写入频率、DB 大小解耦）；flushDatabase() 始终强制立即落盘。
 */
describe('Persist throttle (sql.js export cap)', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-persist-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    await initDatabase(dbPath);
    runMigrations();
    registerProject('Persist Test', projectDir);
    // 落盘设置期产生的一切变更，并把 _lastPersistAt 推到"现在"
    flushDatabase();

    vi.mocked(fs.writeFileSync).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fs.writeFileSync).mockClear();
    try {
      flushDatabase();
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function insert(key: string): void {
    getConnection()
      .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
      .run(key, 'v');
  }

  it('caps export frequency: continuous writes persist at most once per 2s', () => {
    vi.useFakeTimers();

    // 10 次连续写入（模拟 watcher 事件风暴 / 编辑风暴）
    for (let i = 0; i < 10; i++) insert(`k${i}`);

    // 600ms：去抖窗口内，尚未到最小间隔 → 0 次落盘
    vi.advanceTimersByTime(600);
    expect(fs.writeFileSync).not.toHaveBeenCalled();

    // 累计 2.1s：距上次落盘超过 2s → 恰好 1 次（合并了全部 10 次写入）
    vi.advanceTimersByTime(1500);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

    // 持续写入 + 每 2.5s 检查一次：3 个间隔最多 3 次新落盘（含最后一次）
    for (let i = 0; i < 5; i++) insert(`more${i}`);
    vi.advanceTimersByTime(2500);
    for (let i = 5; i < 10; i++) insert(`more${i}`);
    vi.advanceTimersByTime(2500);
    for (let i = 10; i < 15; i++) insert(`more${i}`);
    vi.advanceTimersByTime(2500);

    // 总落盘次数 = 1（首次）+ ≤3 = ≤4，远小于 25 次写入
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('flushDatabase forces immediate persist even with pending debounce', () => {
    vi.useFakeTimers();

    insert('forced');
    vi.advanceTimersByTime(300); // 去抖 500ms 未到
    flushDatabase();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

    // flush 后挂起的定时器已被清除，不再有重复落盘
    vi.advanceTimersByTime(3000);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('persistence regression: flushed writes survive close and reopen', async () => {
    // 真实定时器（重开 initDatabase 是异步 WASM 加载）
    vi.useRealTimers();
    insert('survive-me');
    flushDatabase();
    closeConnection();

    await initDatabase(dbPath);
    const row = getConnection()
      .prepare("SELECT value FROM config WHERE key = 'survive-me'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('v');
  });
});
