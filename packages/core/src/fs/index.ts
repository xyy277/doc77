import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Sensitive file patterns that should never be exposed.
 */
const SENSITIVE_PATTERNS = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.git',
  '.gitignore',
  '.gitattributes',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__',
  '.idea',
  '.vscode',
];

const SENSITIVE_EXTENSIONS = ['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore'];

export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: string;
}

/**
 * Read the content of a file as UTF-8 string.
 */
export function readFile(absolutePath: string): string {
  return fs.readFileSync(absolutePath, 'utf-8');
}

/**
 * Get file/directory stats.
 */
export function statFile(absolutePath: string): fs.Stats {
  return fs.statSync(absolutePath);
}

/**
 * List direct children of a directory, excluding sensitive files.
 */
export function listDir(absolutePath: string): DirEntry[] {
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  const result: DirEntry[] = [];

  for (const entry of entries) {
    if (isSensitiveFile(entry.name)) {
      continue;
    }

    const fullPath = path.join(absolutePath, entry.name);
    try {
      const stats = fs.statSync(fullPath);
      result.push({
        name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        modified: stats.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat (permission errors, broken symlinks, etc.)
    }
  }

  return result;
}

/**
 * Check whether a file/directory name matches sensitive patterns.
 */
export function isSensitiveFile(name: string): boolean {
  if (SENSITIVE_PATTERNS.includes(name)) {
    return true;
  }

  const ext = path.extname(name).toLowerCase();
  if (SENSITIVE_EXTENSIONS.includes(ext)) {
    return true;
  }

  return false;
}

/**
 * Validate that a requested path is within the project root.
 * Resolves symlinks to prevent traversal attacks.
 * Returns the resolved absolute path if valid, throws otherwise.
 */
export function validatePath(projectRoot: string, requestedPath: string): string {
  // Resolve project root to absolute
  const root = path.resolve(projectRoot);

  // Resolve the requested path relative to root
  const candidate = path.resolve(root, requestedPath);

  // Check basic traversal: candidate must start with root
  if (!candidate.startsWith(root + path.sep) && candidate !== root) {
    throw new Error(`Path traversal denied: "${requestedPath}" is outside project root.`);
  }

  // Resolve symlinks to get real path
  let realPath: string;
  try {
    realPath = fs.realpathSync(candidate);
  } catch {
    // If path doesn't exist yet (e.g., for write operations), use candidate
    // But resolve parent directories
    const parentDir = path.dirname(candidate);
    let realParent: string;
    try {
      realParent = fs.realpathSync(parentDir);
    } catch {
      throw new Error(`Parent directory does not exist: "${requestedPath}"`);
    }
    realPath = path.join(realParent, path.basename(candidate));
  }

  // Recheck after symlink resolution
  if (!realPath.startsWith(root + path.sep) && realPath !== root) {
    throw new Error(`Symlink traversal denied: "${requestedPath}" resolves outside project root.`);
  }

  return candidate;
}

/**
 * Resolve a user-provided project path to an absolute, normalized path.
 *
 * Handles:
 * - `~` expansion (e.g., `~/work/docs` → `/home/user/work/docs`)
 * - Windows path on WSL (e.g., `D:\\agent\\kit` → `/mnt/d/agent/kit`)
 * - Relative paths (e.g., `./my-project` → `/cwd/my-project`)
 *
 * Throws if the resolved path does not exist.
 */
export function resolveProjectPath(rawPath: string): string {
  let resolved = rawPath;

  // 1. Expand ~ to home directory
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }

  // 2. Detect Windows-style absolute paths (e.g., D:\... or C:/...)
  //    and try to convert via wslpath if available
  if (/^[A-Za-z]:[/\\]/.test(resolved)) {
    const wslPath = tryWslPath(resolved);
    if (wslPath) {
      resolved = wslPath;
    }
  }

  // 3. Resolve to absolute path
  resolved = path.resolve(resolved);

  return resolved;
}

/**
 * Try to convert a Windows path to WSL path using `wslpath`.
 * Returns null if wslpath is not available or conversion fails.
 */
function tryWslPath(windowsPath: string): string | null {
  try {
    const result = execSync(`wslpath -u "${windowsPath}"`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    // Verify the result is a valid Linux path
    if (result.startsWith('/')) {
      return result;
    }
  } catch {
    // wslpath not available, not on WSL, or conversion failed
  }
  return null;
}

