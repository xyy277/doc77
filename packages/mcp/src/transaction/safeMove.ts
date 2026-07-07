import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Atomic file move with cross-device fallback.
 *
 * Uses fs.rename for same-device moves (atomic).
 * On EXDEV (cross-device), copies to a UUID temp file on the target device,
 * then atomically renames into place, then deletes the source.
 */
export async function safeMove(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'EXDEV') {
      const uniqueId = randomUUID();
      const tempDest = `${dest}.${uniqueId}.doc77tmp`;
      try {
        await fs.promises.copyFile(src, tempDest);
        await fs.promises.rename(tempDest, dest);
        await fs.promises.unlink(src);
      } catch (innerErr) {
        // Clean up temp file on failure
        try {
          await fs.promises.unlink(tempDest);
        } catch {
          /* ignore */
        }
        throw innerErr;
      }
    } else {
      throw err;
    }
  }
}
