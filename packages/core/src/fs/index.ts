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
 * Read a file as a raw Buffer (no encoding).
 */
export function readFileRaw(absolutePath: string): Buffer {
  return fs.readFileSync(absolutePath);
}

/**
 * Detect if a file is binary by checking for null bytes in the first 8KB.
 * Text files virtually never contain null bytes. Returns true if binary.
 */
export function isBinaryFile(absolutePath: string): boolean {
  try {
    const fd = fs.openSync(absolutePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    // Check for null bytes in the sample
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    // If we can't read the file, treat as binary for safety
    return true;
  }
}

/**
 * Read only the first N lines of a text file. Returns { content, truncated, totalBytes }.
 */
export function readFirstNLines(absolutePath: string, maxLines: number): { content: string; truncated: boolean; totalBytes: number } {
  const stats = fs.statSync(absolutePath);
  const totalBytes = stats.size;
  const fd = fs.openSync(absolutePath, 'r');
  const buf = Buffer.alloc(65536); // 64KB chunks
  let pos = 0, lines = 0;
  const parts: string[] = [];

  while (lines < maxLines && pos < totalBytes) {
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    const chunk = buf.toString('utf-8', 0, bytesRead);
    const chunkLines = chunk.split('\n');
    lines += chunkLines.length - 1;
    if (lines >= maxLines) {
      // Only include lines up to maxLines
      const takeLines = chunkLines.slice(0, maxLines - (lines - chunkLines.length + 1));
      parts.push(takeLines.join('\n'));
      break;
    }
    parts.push(chunk);
    pos += bytesRead;
  }
  fs.closeSync(fd);

  const content = parts.join('');
  return { content, truncated: pos < totalBytes, totalBytes };
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
 * Platform-aware logic:
 * - Native Windows:   keeps Windows paths (D:\\foo), expands ~ to %USERPROFILE%
 * - WSL (Linux+microsoft kernel): converts Windows paths → /mnt/d/... via wslpath
 * - Native Linux/macOS: expands ~ to $HOME, rejects Windows paths with a clear error
 * - Relative paths are resolved against cwd
 */
export function resolveProjectPath(rawPath: string): string {
  let resolved = rawPath;

  // 1. Expand ~ to home directory
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }

  const isWinPath = /^[A-Za-z]:[/\\]/.test(resolved);

  // 2. Native Windows — keep Windows paths as-is
  if (process.platform === 'win32') {
    return path.resolve(resolved);
  }

  // 3. WSL environment — convert Windows paths to Linux mount points
  if (isWinPath && isWsl()) {
    const converted = tryWslPath(resolved);
    if (converted) return converted;
    // wslpath failed but we're in WSL — fall through to resolve
  }

  // 4. Native Linux/macOS with a Windows path — error
  if (isWinPath && !isWsl()) {
    throw new Error(
      `Windows path "${rawPath}" is not valid on ${process.platform}. ` +
      'Use a Linux path (e.g., /home/user/docs) or run inside WSL for Windows paths.',
    );
  }

  // 5. Standard Linux/macOS path
  return path.resolve(resolved);
}

/**
 * Check if the current process is running inside Windows Subsystem for Linux.
 */
function isWsl(): boolean {
  try {
    const content = fs.readFileSync('/proc/version', 'utf-8');
    return content.toLowerCase().includes('microsoft') || content.toLowerCase().includes('wsl');
  } catch {
    return false;
  }
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
    if (result.startsWith('/')) {
      return result;
    }
  } catch {
    // wslpath not available or conversion failed
  }
  return null;
}

