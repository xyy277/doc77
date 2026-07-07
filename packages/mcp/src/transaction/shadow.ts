import * as path from 'node:path';
import * as fs from 'node:fs';

export interface UndoLogEntry {
  type: string;
  originalPath?: string;
  shadowPath?: string;
  [key: string]: unknown;
}

export type UndoLog = UndoLogEntry[];

/**
 * Perform shadow backup for a batch of operations.
 * Backs up files that will be modified/deleted to the shadow directory.
 * Returns the undo log for potential rollback.
 */
export function performShadowBackup(
  operations: Array<{ type: string; file_path?: string; [key: string]: unknown }>,
  projectRoot: string,
  shadowDir: string,
): UndoLog {
  if (!fs.existsSync(shadowDir)) {
    fs.mkdirSync(shadowDir, { recursive: true });
  }

  const undoLog: UndoLog = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const entry: UndoLogEntry = { type: op.type, originalPath: op.file_path };
    const absPath = op.file_path ? path.join(projectRoot, op.file_path) : null;

    switch (op.type) {
      case 'write_file': {
        // If file exists, backup to shadow
        if (absPath && fs.existsSync(absPath)) {
          const shadowName = `op${i}_${path.basename(op.file_path!)}`;
          const shadowPath = path.join(shadowDir, shadowName);
          fs.copyFileSync(absPath, shadowPath);
          entry.shadowPath = shadowPath;
        }
        undoLog.push(entry);
        break;
      }
      case 'delete_file': {
        // Move file to shadow instead of deleting
        if (absPath && fs.existsSync(absPath)) {
          const shadowName = `op${i}_${path.basename(op.file_path!)}`;
          const shadowPath = path.join(shadowDir, shadowName);
          fs.renameSync(absPath, shadowPath);
          entry.shadowPath = shadowPath;
        }
        undoLog.push(entry);
        break;
      }
      case 'create_folder': {
        undoLog.push({ ...entry, folderPath: op.folder_path });
        break;
      }
      case 'move_file': {
        if (op.source && op.target) {
          undoLog.push({
            type: 'move_file',
            source: op.source,
            target: op.target,
          });
        }
        break;
      }
    }
  }

  return undoLog;
}

/**
 * Rollback operations by restoring files from shadow.
 * Executes in reverse order.
 */
export function rollbackFromShadow(undoLog: UndoLog, projectRoot: string, shadowDir: string): void {
  // Reverse the order
  const reversed = [...undoLog].reverse();

  for (const entry of reversed) {
    switch (entry.type) {
      case 'write_file': {
        if (entry.shadowPath && entry.originalPath) {
          const destPath = path.join(projectRoot, entry.originalPath);
          // Restore original from shadow
          fs.copyFileSync(entry.shadowPath, destPath);
        } else if (entry.originalPath) {
          // New file was created — delete it
          const destPath = path.join(projectRoot, entry.originalPath);
          try {
            fs.unlinkSync(destPath);
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case 'delete_file': {
        if (entry.shadowPath && entry.originalPath) {
          const destPath = path.join(projectRoot, entry.originalPath);
          // Move back from shadow
          fs.renameSync(entry.shadowPath, destPath);
        }
        break;
      }
      case 'create_folder': {
        if (entry.folderPath) {
          const dirPath = path.join(projectRoot, entry.folderPath as string);
          try {
            fs.rmdirSync(dirPath);
          } catch {
            /* ignore - may not be empty */
          }
        }
        break;
      }
      case 'move_file': {
        if (entry.source && entry.target) {
          // Move back
          const src = path.join(projectRoot, entry.target as string);
          const dest = path.join(projectRoot, entry.source as string);
          try {
            fs.renameSync(src, dest);
          } catch {
            /* ignore */
          }
        }
        break;
      }
    }
  }

  // Clean up shadow directory
  try {
    fs.rmSync(shadowDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
