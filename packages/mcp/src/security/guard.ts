import { getConnection, isSensitiveFile, validatePath } from '@doc77/core';

/**
 * Security check result for MCP operations.
 */
export interface SecurityCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Verify that a path is within project boundaries and not sensitive.
 */
export function checkPathAccess(projectId: number, filePath: string): SecurityCheck {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;

  if (!project) {
    return { allowed: false, reason: `Project not found: ${projectId}` };
  }

  // Validate path is within project root
  try {
    validatePath(project.path, filePath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { allowed: false, reason: message };
  }

  return { allowed: true };
}

/**
 * Check if the file is sensitive and should not be accessed via MCP.
 */
export function checkSensitiveFile(filename: string): SecurityCheck {
  if (isSensitiveFile(filename)) {
    return {
      allowed: false,
      reason: `Access denied: "${filename}" is a sensitive file`,
    };
  }
  return { allowed: true };
}

/**
 * Validate depth limit for directory listing.
 */
export function checkDepthLimit(depth: number, maxDepth: number = 5): SecurityCheck {
  if (depth > maxDepth) {
    return {
      allowed: false,
      reason: `Depth ${depth} exceeds maximum allowed depth of ${maxDepth}`,
    };
  }
  return { allowed: true };
}
