/**
 * Local directory mirror adapter — sync to another local folder / network mount.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SyncAdapter,
  AdapterConfig,
  ConnectionResult,
  SyncContext,
  PullResult,
  PushResult,
  RemoteFileEntry,
} from '../types.js';

export interface LocalAdapterConfig extends AdapterConfig {
  type: 'local';
  targetPath: string;
  mirror: boolean; // true = delete sync, false = incremental only
  ignorePatterns: string[];
}

export class LocalAdapter implements SyncAdapter {
  readonly name = 'local';
  readonly displayName = 'Local Directory';

  async testConnection(config: AdapterConfig): Promise<ConnectionResult> {
    const cfg = config as LocalAdapterConfig;
    if (fs.existsSync(cfg.targetPath)) {
      return { ok: true, message: `Directory exists: ${cfg.targetPath}` };
    }
    try {
      fs.mkdirSync(cfg.targetPath, { recursive: true });
      return { ok: true, message: `Created directory: ${cfg.targetPath}` };
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : 'Cannot access path' };
    }
  }

  async listRemote(config: AdapterConfig): Promise<RemoteFileEntry[]> {
    const cfg = config as LocalAdapterConfig;
    const entries: RemoteFileEntry[] = [];
    this.walkDir(cfg.targetPath, cfg.targetPath, entries, cfg.ignorePatterns || []);
    return entries;
  }

  async pull(ctx: SyncContext): Promise<PullResult> {
    const cfg = (ctx.options as any).adapterConfig as LocalAdapterConfig;
    const result: PullResult = { filesUpdated: 0, filesDeleted: 0, errors: [] };

    try {
      const remoteFiles = await this.listRemote(cfg);
      for (const remote of remoteFiles) {
        const localPath = path.join(ctx.projectPath, remote.path);
        try {
          let needsUpdate = true;
          if (fs.existsSync(localPath)) {
            const stat = fs.statSync(localPath);
            if (stat.mtime.getTime() >= new Date(remote.lastModified).getTime()) needsUpdate = false;
          }
          if (!needsUpdate) continue;

          const dir = path.dirname(localPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(path.join(cfg.targetPath, remote.path), localPath);
          result.filesUpdated++;
        } catch (e: unknown) {
          result.errors.push(`${remote.path}: ${e instanceof Error ? e.message : 'copy failed'}`);
        }
      }
    } catch (e: unknown) {
      result.errors.push(e instanceof Error ? e.message : 'Pull failed');
    }
    return result;
  }

  async push(ctx: SyncContext): Promise<PushResult> {
    const cfg = (ctx.options as any).adapterConfig as LocalAdapterConfig;
    const result: PushResult = { filesPushed: 0, errors: [] };

    for (const change of ctx.changedFiles) {
      const targetFile = path.join(cfg.targetPath, change.path);
      try {
        if (change.type === 'deleted') {
          if (cfg.mirror && fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
        } else {
          const dir = path.dirname(targetFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(path.join(ctx.projectPath, change.path), targetFile);
          result.filesPushed++;
        }
      } catch (e: unknown) {
        result.errors.push(`${change.path}: ${e instanceof Error ? e.message : 'copy failed'}`);
      }
    }
    return result;
  }

  private walkDir(root: string, dir: string, entries: RemoteFileEntry[], ignore: string[]): void {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const full = path.join(dir, item.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (ignore.some((p) => rel.includes(p))) continue;
        if (item.isDirectory()) {
          this.walkDir(root, full, entries, ignore);
        } else {
          const stat = fs.statSync(full);
          entries.push({ path: rel, size: stat.size, lastModified: stat.mtime.toISOString() });
        }
      }
    } catch { /* permission etc. */ }
  }
}

