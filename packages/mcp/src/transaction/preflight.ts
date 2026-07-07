import { getConnection, validatePath } from '@doc77/core';

export interface PreflightResult {
  passed: boolean;
  errors: string[];
}

interface Operation {
  type: string;
  file_path?: string;
  folder_path?: string;
  source?: string;
  target?: string;
  [key: string]: unknown;
}

/**
 * Run non-destructive pre-flight checks on a batch of operations.
 * Validates path safety and basic filesystem constraints.
 */
export function runPreflightCheck(projectId: number, operations: Operation[]): PreflightResult {
  const errors: string[] = [];
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;

  if (!project) {
    return { passed: false, errors: ['Project not found'] };
  }

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const opLabel = `Operation ${i + 1} (${op.type})`;

    // Get the path(s) to validate
    const pathsToCheck: string[] = [];
    if (op.file_path) pathsToCheck.push(op.file_path);
    if (op.folder_path) pathsToCheck.push(op.folder_path);
    if (op.source) pathsToCheck.push(op.source);
    if (op.target) pathsToCheck.push(op.target);

    for (const p of pathsToCheck) {
      try {
        validatePath(project.path, p);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`${opLabel}: ${msg}`);
      }
    }
  }

  return { passed: errors.length === 0, errors };
}
