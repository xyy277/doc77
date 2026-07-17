import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Tag definitions: detection signal files → tag name */
const TAG_SIGNALS: Array<{ tag: string; files: string[]; matchGlob?: boolean }> = [
  { tag: 'nodejs', files: ['package.json'] },
  { tag: 'typescript', files: ['tsconfig.json'] },
  { tag: 'python', files: ['requirements.txt', 'pyproject.toml', 'setup.py'] },
  { tag: 'go', files: ['go.mod'] },
  { tag: 'rust', files: ['Cargo.toml'] },
  { tag: 'java', files: ['pom.xml', 'build.gradle'] },
  { tag: 'dotnet', files: ['*.csproj', '*.sln'], matchGlob: true },
  { tag: 'git', files: ['.git'] },
];

function hasFile(dirPath: string, filename: string): boolean {
  try {
    return fs.existsSync(path.join(dirPath, filename));
  } catch {
    return false;
  }
}

/**
 * Auto-detect project tags by scanning for config files in the directory.
 */
export function detectProjectTags(dirPath: string): string[] {
  const tags: string[] = [];
  let expanded = dirPath.startsWith('~') ? os.homedir() + dirPath.slice(1) : dirPath;

  for (const signal of TAG_SIGNALS) {
    if (signal.matchGlob) {
      try {
        const entries = fs.readdirSync(expanded, { withFileTypes: true });
        const found = entries.some(e =>
          e.isFile() &&
          signal.files.some(f => {
            if (!f.startsWith('*.')) return e.name === f;
            const ext = f.slice(1); // *.csproj → .csproj
            return e.name.endsWith(ext);
          })
        );
        if (found) tags.push(signal.tag);
      } catch {
        /* skip unreadable directories */
      }
    } else {
      const found = signal.files.some(f => hasFile(expanded, f));
      if (found) tags.push(signal.tag);
    }
  }

  return tags;
}

/** Directories always skipped during git discovery */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.svn', '.hg',
  '.venv', 'venv', '.tox', 'dist', '.cache', '.next', '.nuxt',
  'build', 'target', '.terraform', '.serverless',
]);

/**
 * Scan a directory recursively for git repositories.
 * @param rootDir Starting directory
 * @param depth Max recursion depth (2-5, default 3)
 */
export function discoverGitProjects(
  rootDir: string,
  depth: number = 3,
): Array<{ path: string; name: string; tags: string[] }> {
  const results: Array<{ path: string; name: string; tags: string[] }> = [];
  const clampedDepth = Math.min(5, Math.max(2, depth || 3));

  let expanded = rootDir.startsWith('~') ? os.homedir() + rootDir.slice(1) : rootDir;
  expanded = path.resolve(expanded);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(expanded);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  function walk(dir: string, d: number): void {
    if (d > clampedDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check for .git in subdirectories only (not the root itself)
    if (d > 0) {
      const hasGit = entries.some(e => e.name === '.git' && e.isDirectory());
      if (hasGit) {
        const fullPath = path.resolve(dir);
        const tags = detectProjectTags(fullPath);
        results.push({ path: fullPath, name: path.basename(dir), tags });
        return; // don't recurse into discovered repos
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), d + 1);
    }
  }

  walk(expanded, 0);
  return results;
}

/**
 * Parse a VS Code .code-workspace file and resolve folder paths.
 */
export function parseCodeWorkspace(
  workspacePath: string,
): Array<{ path: string; name: string }> {
  let expanded = workspacePath.startsWith('~')
    ? os.homedir() + workspacePath.slice(1)
    : workspacePath;
  expanded = path.resolve(expanded);

  let raw: string;
  try {
    raw = fs.readFileSync(expanded, 'utf-8');
  } catch {
    return [];
  }

  let ws: any;
  try {
    ws = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!ws.folders || !Array.isArray(ws.folders)) return [];

  const workspaceDir = path.dirname(expanded);

  return ws.folders.map((f: any) => {
    const folderPath = path.resolve(workspaceDir, f.path || '');
    return {
      path: folderPath,
      name: f.name || path.basename(folderPath),
    };
  });
}
