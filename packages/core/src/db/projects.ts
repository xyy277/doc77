import { getConnection } from './connection.js';

export interface Project {
  id: number;
  name: string;
  path: string;
  obsidian_mode: boolean;
  created_at: string;
  last_opened: string | null;
}

export interface ProjectUpdate {
  name?: string;
  path?: string;
  obsidian_mode?: boolean;
}

/**
 * Register a new project.
 * Throws if the path already exists (UNIQUE constraint).
 */
export function registerProject(name: string, projectPath: string, obsidianMode?: boolean): Project {
  const db = getConnection();
  const stmt = db.prepare(
    `INSERT INTO projects (name, path, obsidian_mode) VALUES (?, ?, ?)`
  );
  const result = stmt.run(name, projectPath, obsidianMode ? 1 : 0);
  if (result.lastInsertRowid === 0) {
    throw new Error(`Project path already exists: ${projectPath}`);
  }
  return {
    id: Number(result.lastInsertRowid),
    name,
    path: projectPath,
    obsidian_mode: !!obsidianMode,
    created_at: new Date().toISOString(),
    last_opened: null,
  };
}

/**
 * List all registered projects, ordered by name.
 */
export function listProjects(): Project[] {
  const db = getConnection();
  const rows = db
    .prepare('SELECT id, name, path, obsidian_mode, created_at, last_opened FROM projects ORDER BY name')
    .all() as Array<Project & { obsidian_mode: number }>;
  return rows.map(r => ({ ...r, obsidian_mode: !!r.obsidian_mode }));
}

/**
 * Remove a project by id.
 * Returns true if removed, false if not found.
 */
export function removeProject(id: number): boolean {
  const db = getConnection();
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Update last_opened timestamp.
 */
export function touchProject(id: number): void {
  const db = getConnection();
  db.prepare('UPDATE projects SET last_opened = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

/**
 * Update project name and/or path.
 */
export function updateProject(id: number, updates: ProjectUpdate): void {
  const db = getConnection();
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.path !== undefined) {
    sets.push('path = ?');
    params.push(updates.path);
  }
  if (updates.obsidian_mode !== undefined) {
    sets.push('obsidian_mode = ?');
    params.push(updates.obsidian_mode ? 1 : 0);
  }

  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
