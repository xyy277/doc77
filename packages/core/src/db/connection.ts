import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

let db: Database.Database | null = null;

/**
 * Initialize the SQLite database connection.
 * Creates parent directories if needed, enables WAL mode and foreign keys.
 */
export function initDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON');

  return db;
}

/**
 * Get the current database connection.
 * Throws if initDatabase hasn't been called.
 */
export function getConnection(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection gracefully.
 */
export function closeConnection(): void {
  if (db) {
    db.close();
    db = null;
  }
}
