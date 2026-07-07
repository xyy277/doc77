import { getConnection } from './connection.js';

export interface Project {
  id: number;
  name: string;
  path: string;
  created_at: string;
  last_opened: string | null;
}

export interface ProjectUpdate {
  name?: string;
  path?: string;
}

/**
 * Register a new project.
 * Throws if the path already exists (UNIQUE constraint).
 */
export function registerProject(name: string, projectPath: string): Project {
  const db = getConnection();
  const stmt = db.prepare(`INSERT INTO projects (name, path) VALUES (?, ?)`);
  const result = stmt.run(name, projectPath);
  return {
    id: Number(result.lastInsertRowid),
    name,
    path: projectPath,
    created_at: new Date().toISOString(),
    last_opened: null,
  };
}

/**
 * List all registered projects, ordered by name.
 */
export function listProjects(): Project[] {
  const db = getConnection();
  return db
    .prepare('SELECT id, name, path, created_at, last_opened FROM projects ORDER BY name')
    .all() as Project[];
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

  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
