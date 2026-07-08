import * as path from 'node:path';
import * as fs from 'node:fs';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase, SqlJsStatic, Statement as SqlJsStatement } from 'sql.js';

/***********************************************
 * sql.js → better-sqlite3 compatibility layer
 *
 * initDatabase() is async (loads WASM once).
 * After init, getConnection() returns a
 * DatabaseCompat with .prepare().get()/.all()/.run()
 * and .transaction() — same API as better-sqlite3.
 ***********************************************/

let rawDb: SqlJsDatabase | null = null;
let dbPath: string | null = null;
let wrappedDb: DatabaseCompat | null = null;

// ── Statement wrapper ──────────────────────────────────

export class StatementCompat {
  private _db: SqlJsDatabase;
  private _sql: string;

  constructor(db: SqlJsDatabase, sql: string) {
    this._db = db;
    this._sql = sql;
  }

  run(...params: unknown[]) {
    const stmt = this._db.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    stmt.step(); // Don't catch — let constraint violations throw
    let lastInsertRowid = 0;
    let changes = 0;
    if (/^\s*INSERT\b/i.test(this._sql.trim())) {
      const idStmt = this._db.prepare('SELECT last_insert_rowid() as id');
      if (idStmt.step()) lastInsertRowid = idStmt.getAsObject().id as number;
      idStmt.free();
      changes = 1;
    } else if (/^\s*(UPDATE|DELETE)\b/i.test(this._sql.trim())) {
      changes = this._db.getRowsModified();
    }
    stmt.free();
    return { changes, lastInsertRowid };
  }

  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined {
    const stmt = this._db.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    try {
      if (stmt.step()) {
        const r = stmt.getAsObject() as T;
        stmt.free();
        return r;
      }
    } catch { stmt.free(); return undefined; }
    stmt.free();
    return undefined;
  }

  all<T = Record<string, unknown>>(...params: unknown[]): T[] {
    const stmt = this._db.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    const results: T[] = [];
    try { while (stmt.step()) results.push(stmt.getAsObject() as T); } catch {}
    stmt.free();
    return results;
  }
}

// ── Database wrapper ───────────────────────────────────

export class DatabaseCompat {
  private _db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this._db = db;
  }

  get open(): boolean {
    try { this._db.exec('SELECT 1'); return true; } catch { return false; }
  }

  exec(sql: string) {
    this._db.run(sql);
  }

  prepare(sql: string): StatementCompat {
    return new StatementCompat(this._db, sql);
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      try {
        this._db.run('BEGIN');
        const r = fn(...args);
        this._db.run('COMMIT');
        return r;
      } catch (err) {
        try { this._db.run('ROLLBACK'); } catch {}
        throw err;
      }
    };
  }

  /** Internal: save to disk and close */
  _saveAndClose(filePath: string) {
    const data = this._db.export();
    const buf = Buffer.from(data);
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
    this._db.close();
  }
}

// ── Exported API ───────────────────────────────────────

let sqlModule: SqlJsStatic | null = null;

/**
 * Initialize the database.
 * On first call, loads sql.js WASM (async).
 * Subsequent calls with same path reuse existing connection.
 */
export async function initDatabase(filePath: string): Promise<DatabaseCompat> {
  if (rawDb && wrappedDb) return wrappedDb;

  // Load WASM once
  if (!sqlModule) {
    sqlModule = await initSqlJs();
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let buffer: Buffer | undefined;
  if (fs.existsSync(filePath)) buffer = fs.readFileSync(filePath);

  rawDb = new sqlModule.Database(buffer);
  dbPath = filePath;
  rawDb.run('PRAGMA foreign_keys = ON');
  wrappedDb = new DatabaseCompat(rawDb);
  return wrappedDb;
}

/** Get current connection (must call initDatabase first). */
export function getConnection(): DatabaseCompat {
  if (!rawDb || !wrappedDb) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return wrappedDb;
}

/** Close and save the database. */
export function closeConnection(): void {
  if (rawDb && dbPath) {
    try { wrappedDb?._saveAndClose(dbPath); } catch { rawDb.close(); }
    rawDb = null;
    wrappedDb = null;
    dbPath = null;
  }
}
