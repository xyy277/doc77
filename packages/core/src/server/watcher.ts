import * as path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { listProjects } from '../db/projects.js';
import { clearCache } from '../scanner/index.js';
import { getEventBus } from './event-bus.js';

/**
 * 文件系统监听器 — 将磁盘变化（外部编辑器 / git pull / webdav 同步 /
 * agent 通过 MCP 写入等）转换为 file-tree:changed 事件，驱动前端目录树
 * 局部刷新（SSE 推送）。
 *
 * 变更按 (projectId, relDir) 去抖合并：git pull 100 个文件只产生少量事件；
 * paths 数组上限 MAX_PATHS_PER_EVENT，超出置 truncated 标记。
 * watcher 是尽力而为组件：启动失败不阻断服务器启动（降级为手动刷新）。
 */

export interface WatcherOptions {
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
const MAX_PATHS_PER_EVENT = 50;
// 引用计数归零后延迟停止，防页面 reload 循环反复触发 chokidar 全树重扫；
// 浏览器 EventSource 断线默认 ~3s 重试，10s 窗口覆盖翻覆场景
const DEFAULT_IDLE_STOP_MS = 10_000;
// 初始枚举窗口期兜底补发延迟（见 scheduleInitialSyncEmit）
const INITIAL_SYNC_EMIT_DELAY_MS = 5000;

// 忽略 .git / 回收站 / node_modules / 隐藏文件
// （chokidar v4：watch() 的路径不支持 glob，ignored 支持 glob 与正则）
const IGNORED = [
  '**/.git',
  '**/.git/**',
  '**/.doc77-trash',
  '**/.doc77-trash/**',
  '**/node_modules',
  '**/node_modules/**',
  /(^|[/\\])\../,
];

const EVENT_TO_OP: Record<string, string> = {
  add: 'create',
  addDir: 'create',
  change: 'modify',
  unlink: 'delete',
  unlinkDir: 'delete',
};

interface PendingEntry {
  opTypes: Set<string>;
  paths: string[];
  truncated: boolean;
}

let _watcher: FSWatcher | null = null;
let _debounceMs = DEFAULT_DEBOUNCE_MS;
let _rootToProject = new Map<string, number>();
let _pending = new Map<number, Map<string, PendingEntry>>();
let _timers = new Map<string, ReturnType<typeof setTimeout>>();
let _ready = false;
let _readyResolvers: Array<() => void> = [];
// 惰性启停（v1.1.4）：首个 SSE 客户端连接才启动 watcher，最后一个断开后
// 延迟停止 —— 无客户端时零开销（chokidar 初始全树枚举 + inotify 占用）
let _refCount = 0;
let _idleStopTimer: ReturnType<typeof setTimeout> | null = null;

function timerKey(projectId: number, relDir: string): string {
  return projectId + '|' + relDir;
}

function flush(projectId: number, relDir: string): void {
  const byDir = _pending.get(projectId);
  if (!byDir) return;
  const entry = byDir.get(relDir);
  if (!entry) return;
  byDir.delete(relDir);
  if (byDir.size === 0) _pending.delete(projectId);
  const key = timerKey(projectId, relDir);
  const timer = _timers.get(key);
  if (timer) clearTimeout(timer);
  _timers.delete(key);

  const opType = entry.opTypes.size > 1 ? 'mixed' : [...entry.opTypes][0] || 'modify';
  clearCache(projectId, relDir === '' ? undefined : relDir);
  try {
    getEventBus().emit('file-tree:changed', {
      projectId,
      path: relDir,
      opType,
      paths: entry.paths,
      truncated: entry.truncated,
    });
  } catch {
    /* best-effort */
  }
}

function schedule(projectId: number, relDir: string, opType: string, relPath: string): void {
  let byDir = _pending.get(projectId);
  if (!byDir) {
    byDir = new Map();
    _pending.set(projectId, byDir);
  }
  let entry = byDir.get(relDir);
  if (!entry) {
    entry = { opTypes: new Set(), paths: [], truncated: false };
    byDir.set(relDir, entry);
    const timer = setTimeout(() => flush(projectId, relDir), _debounceMs);
    // 不阻止进程退出（服务器常驻本身持有事件循环，此处仅为测试/退出兜底）
    timer.unref?.();
    _timers.set(timerKey(projectId, relDir), timer);
  }
  entry.opTypes.add(opType);
  if (!entry.truncated) {
    if (entry.paths.length < MAX_PATHS_PER_EVENT) {
      if (!entry.paths.includes(relPath)) entry.paths.push(relPath);
    } else {
      entry.truncated = true;
    }
  }
}

/** 事件 → 项目归属与相对路径 → 按目录去抖合并 */
function onFsEvent(eventName: string, absPath: string): void {
  const opType = EVENT_TO_OP[eventName];
  if (!opType) return;
  for (const [root, projectId] of _rootToProject) {
    let rel = path.relative(root, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    rel = rel.split(path.sep).join('/');
    const relDir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    schedule(projectId, relDir, opType, rel);
    return;
  }
}

/**
 * 启动文件监听。读取当前所有项目根目录并开始监听；
 * 之后通过项目注册 API 新增的项目由 watchProject 动态接入。
 */
export function startFileWatcher(opts?: WatcherOptions): void {
  if (_watcher) return;
  _debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const w = watch([], {
    ignoreInitial: true,
    persistent: true,
    // v1.1.4 移除 awaitWriteFinish：它对每个被写文件 50ms stat 轮询，
    // 是 CPU 持续占用与事件放大的来源之一；事件提前由 500ms 去抖合并
    ignored: IGNORED,
  });
  w.on('all', (eventName: string, changedPath: string) => {
    try {
      onFsEvent(eventName, changedPath);
    } catch {
      /* best-effort */
    }
  });
  w.on('error', (err: unknown) => {
    // 监听失败不阻断主流程（如 Linux inotify 上限），降级为手动刷新
    console.error('[doc77] file watcher error:', err instanceof Error ? err.message : String(err));
  });
  // 底层 watcher 建立完成后才可靠接收事件（启动瞬间的写入可能丢失——
  // 该窗口极小，服务器自身 REST 操作另有 emitTreeChanged 兜底）
  w.on('ready', () => {
    _ready = true;
    _readyResolvers.forEach((r) => r());
    _readyResolvers = [];
    // v1.1.5 修复：初始枚举窗口期（chokidar 递归建 watch，大项目根可达
    // 数十秒）内发生的文件变化不产生事件（ignoreInitial 抑制枚举事件），
    // 窗口期变化将永久丢失。ready 后为每个项目补发一次全量刷新事件
    // （path=''、paths 为空），前端收到后整树重新拉取纠正。
    for (const [, projectId] of _rootToProject) {
      try {
        getEventBus().emit('file-tree:changed', {
          projectId,
          path: '',
          opType: 'mixed',
          paths: [],
        });
      } catch {
        /* best-effort */
      }
    }
  });
  _watcher = w;
  try {
    for (const p of listProjects()) watchProject(p.id);
  } catch {
    /* DB 未就绪时跳过；项目注册 API 会兜底调用 watchProject */
  }
}

/** 停止监听并清理全部状态（测试与进程退出用）。 */
export function stopFileWatcher(): void {
  if (_idleStopTimer) {
    clearTimeout(_idleStopTimer);
    _idleStopTimer = null;
  }
  _refCount = 0;
  for (const [, timer] of _timers) clearTimeout(timer);
  _timers.clear();
  _pending.clear();
  _rootToProject.clear();
  _ready = false;
  _readyResolvers = [];
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
}

/** 等待底层 watcher 就绪（'ready' 后事件才可靠）。未启动时为立即 resolved。 */
export function watcherReady(): Promise<void> {
  if (!_watcher || _ready) return Promise.resolve();
  return new Promise((resolve) => _readyResolvers.push(resolve));
}

/** 为单个项目接入监听（项目注册成功后调用；watcher 未启动时为 no-op）。 */
export function watchProject(projectId: number): void {
  if (!_watcher) return;
  let root: string | undefined;
  try {
    root = listProjects().find((p) => p.id === projectId)?.path;
  } catch {
    return;
  }
  if (!root) return;
  const absRoot = path.resolve(root);
  if (_rootToProject.has(absRoot)) return;
  _rootToProject.set(absRoot, projectId);
  _watcher.add(absRoot);
}

/** 停止监听某项目并清理其待处理定时器（项目删除时调用）。 */
export function stopWatching(projectId: number): void {
  let root: string | undefined;
  for (const [r, id] of _rootToProject) {
    if (id === projectId) {
      root = r;
      break;
    }
  }
  if (root) {
    _rootToProject.delete(root);
    _watcher?.unwatch(root);
  }
  const byDir = _pending.get(projectId);
  if (byDir) {
    for (const relDir of byDir.keys()) {
      const key = timerKey(projectId, relDir);
      const timer = _timers.get(key);
      if (timer) clearTimeout(timer);
      _timers.delete(key);
    }
    _pending.delete(projectId);
  }
}

/** watcher 是否在运行（测试断言用）。 */
export function isWatcherRunning(): boolean {
  return _watcher !== null;
}

/** 首个 SSE 客户端连接时调用：引用计数 + 启动 watcher（幂等）。 */
export function acquireWatcherRef(): void {
  _refCount++;
  if (_idleStopTimer) {
    clearTimeout(_idleStopTimer);
    _idleStopTimer = null;
  }
  if (!_watcher) {
    try {
      startFileWatcher();
      scheduleInitialSyncEmit();
    } catch {
      /* best-effort — 降级为手动刷新 */
    }
  }
}

/**
 * 初始枚举窗口期兜底（v1.1.5）：chokidar 对大型项目根的递归枚举可能
 * 数十秒甚至不触发 'ready'（inotify 限制等环境问题），期间的文件变化
 * 不产生事件。SSE 连接 5s 后补发一次全量刷新事件；若 'ready' 已触发
 * （ready 补发已覆盖），跳过去重。
 */
function scheduleInitialSyncEmit(): void {
  setTimeout(() => {
    if (_ready) return;
    for (const [, projectId] of _rootToProject) {
      try {
        getEventBus().emit('file-tree:changed', {
          projectId,
          path: '',
          opType: 'mixed',
          paths: [],
        });
      } catch {
        /* best-effort */
      }
    }
  }, INITIAL_SYNC_EMIT_DELAY_MS).unref?.();
}

/** SSE 客户端断开时调用：引用归零后延迟 idleStopMs 停止 watcher。 */
export function releaseWatcherRef(opts?: { idleStopMs?: number }): void {
  _refCount = Math.max(0, _refCount - 1);
  if (_refCount === 0 && _watcher && !_idleStopTimer) {
    const ms = opts?.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    _idleStopTimer = setTimeout(() => {
      _idleStopTimer = null;
      stopFileWatcher();
    }, ms);
    _idleStopTimer.unref?.();
  }
}
