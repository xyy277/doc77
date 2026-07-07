import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConnection, isSensitiveFile, validatePath, readFile } from '@doc77/core';
import { scanDirectory } from '@doc77/core';

/**
 * List files in a project directory.
 */
export async function listFiles(
  projectId: number,
  dirPath: string,
): Promise<ReturnType<typeof scanDirectory>['entries']> {
  const result = scanDirectory(projectId, dirPath);
  return result.entries;
}

/**
 * Read file content with security checks.
 */
export async function readFileContent(projectId: number, filePath: string): Promise<string> {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const fileName = path.basename(filePath);
  if (isSensitiveFile(fileName)) {
    throw new Error(`Access denied: "${fileName}" is a sensitive file`);
  }

  const absPath = validatePath(project.path, filePath);

  // Verify the resolved path is a file (not a directory)
  const stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    throw new Error(`"${filePath}" is a directory, not a file`);
  }

  return readFile(absPath);
}

/**
 * Get file metadata.
 */
export async function getFileInfo(
  projectId: number,
  filePath: string,
): Promise<{
  name: string;
  type: string;
  size: number;
  modified: string;
}> {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const absPath = validatePath(project.path, filePath);
  const stats = fs.statSync(absPath);

  return {
    name: path.basename(filePath),
    type: stats.isDirectory() ? 'directory' : 'file',
    size: stats.size,
    modified: stats.mtime.toISOString(),
  };
}
