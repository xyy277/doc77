import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Run shadow garbage collection on a directory.
 * Cleans up:
 * - Orphan .doc77tmp temporary files
 * - Orphan shadow directories
 */
export function runShadowGC(baseDir: string): void {
  if (!fs.existsSync(baseDir)) return;

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);

    // Clean .doc77tmp files
    if (entry.isFile() && entry.name.endsWith('.doc77tmp')) {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // ignore
      }
    }

    // Clean orphan shadow directories
    if (entry.isDirectory() && entry.name.startsWith('.shadow')) {
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
