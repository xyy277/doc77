import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';

/***********************************************
 * better-sqlite3（原生模块）— 直接驱动，无兼容 shim。
 *
 * initDatabase() 保持 async 签名（cli/electron/33 个测试文件的 await 零改动），
 * 内部同步实现，返回已 resolved 的 promise。
 *
 * 本地结构化接口（NativeDatabase/NativeStatement）保证 better-sqlite3 的
 * 类型不泄漏进 dist/index.d.ts —— @types/better-sqlite3 保持 devDependency，
 * npm 消费者零额外依赖。
 *
 * WAL 模式下每次写语句即落盘（无需 sql.js 时代的 export 序列化 + 去抖写盘），
 * flushDatabase() 因此成为无意义 no-op，仅保留导出兼容。
 ***********************************************/

interface NativeStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface NativeDatabase {
  open: boolean;
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  pragma(sql: string): unknown;
  close(): void;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult;
}

let rawDb: Database.Database | null = null;
let dbPath: string | null = null;
let wrappedDb: DatabaseCompat | null = null;

// ── Statement wrapper ──────────────────────────────────

export class StatementCompat {
  private _db: NativeDatabase;
  private _sql: string;

  constructor(db: NativeDatabase, sql: string) {
    this._db = db;
    this._sql = sql;
  }

  run(...params: unknown[]) {
    // 每次 prepare 即用即弃（对齐旧 shim 生命周期；better-sqlite3 prepare 很便宜，GC 自动 finalize）
    // lastInsertRowid 归一化为 number（bigint → Number），满足调用点的 === 0 / Number() / as number
    const result = this._db.prepare(this._sql).run(...(params as never[]));
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined {
    return this._db.prepare(this._sql).get(...(params as never[])) as T | undefined;
  }

  all<T = Record<string, unknown>>(...params: unknown[]): T[] {
    return this._db.prepare(this._sql).all(...(params as never[])) as T[];
  }
}

// ── Database wrapper ───────────────────────────────────

export class DatabaseCompat {
  private _db: NativeDatabase;

  constructor(db: NativeDatabase) {
    this._db = db;
  }

  get open(): boolean {
    return this._db.open;
  }

  exec(sql: string) {
    this._db.exec(sql);
  }

  prepare(sql: string): StatementCompat {
    return new StatementCompat(this._db, sql);
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    // 原生事务（BEGIN/COMMIT/ROLLBACK + SAVEPOINT 嵌套）
    return this._db.transaction(fn);
  }
}

// ── Exported API ───────────────────────────────────────

let initPromise: Promise<DatabaseCompat> | null = null;

/**
 * Initialize the database.
 * WAL journal + foreign keys。内部同步实现（better-sqlite3 无需 WASM 加载），
 * 保持 async 签名仅为调用方兼容。
 */
export async function initDatabase(filePath: string): Promise<DatabaseCompat> {
  if (rawDb && wrappedDb) return wrappedDb;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    rawDb = new Database(filePath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');
    // 修复前未设 busy_timeout（SQLite 默认 0ms）：同进程多连接并发写
    //（MCP 副本、sync 定时器、图谱重建与保存链同时写 data.db）会立即
    // 抛 SQLITE_BUSY。5s 等待窗口让写冲突排队而非失败。
    rawDb.pragma('busy_timeout = 5000');
    dbPath = filePath;
    wrappedDb = new DatabaseCompat(rawDb);
    return wrappedDb;
  })();

  return initPromise;
}

/** DB 文件绝对路径（initDatabase 后可用；config.key 等附属文件与它同目录）。 */
export function getDbPath(): string | null {
  return dbPath;
}

/** Get current connection (must call initDatabase first). */
export function getConnection(): DatabaseCompat {
  if (!rawDb || !wrappedDb) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return wrappedDb;
}

/**
 * Close the database connection. WAL 模式下数据已逐语句落盘，close 时
 * SQLite 自动 checkpoint，无需额外持久化。
 */
export function closeConnection(): void {
  if (rawDb) {
    try {
      rawDb.close();
    } catch {
      /* ignore */
    }
    rawDb = null;
    wrappedDb = null;
    dbPath = null;
    initPromise = null;
  }
}

/**
 * No-op（API 兼容保留）：better-sqlite3 WAL 模式下每次写语句即落盘，
 * sql.js 时代的"强制立即 export 落盘"语义已不存在。
 */
export function flushDatabase(): void {}
