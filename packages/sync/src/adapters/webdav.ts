/**
 * WebDAV sync adapter — for NAS (Synology, Nextcloud, ownCloud).
 *
 * T9 E2EE: 若 keyring 已 unlock，push 时加密文件内容，pull 时自动解密。
 */
import { createClient, type WebDAVClient } from 'webdav';
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
import { getKeyring } from '../crypto/keyring.js';
import { maybeEncryptContent, maybeDecryptContent } from '../crypto/e2ee-helper.js';

export interface WebDAVAdapterConfig extends AdapterConfig {
  type: 'webdav';
  endpoint: string;
  username: string;
  password: string;
  remotePath: string;
  ignorePatterns: string[];
}

export class WebDAVAdapter implements SyncAdapter {
  readonly name = 'webdav';
  readonly displayName = 'WebDAV (NAS)';

  private getClient(config: WebDAVAdapterConfig): WebDAVClient {
    return createClient(config.endpoint, {
      username: config.username,
      password: config.password,
    });
  }

  async testConnection(config: AdapterConfig): Promise<ConnectionResult> {
    const cfg = config as WebDAVAdapterConfig;
    try {
      const client = this.getClient(cfg);
      const items = await client.getDirectoryContents(cfg.remotePath || '/', { deep: false });
      return {
        ok: true,
        message: `Connected. ${Array.isArray(items) ? items.length : 0} items in root.`,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      if (msg.includes('401')) return { ok: false, message: 'Authentication failed (401)' };
      if (msg.includes('ECONNREFUSED') || msg.includes('timeout'))
        return { ok: false, message: 'Cannot reach server' };
      return { ok: false, message: msg };
    }
  }

  async listRemote(config: AdapterConfig): Promise<RemoteFileEntry[]> {
    const cfg = config as WebDAVAdapterConfig;
    const client = this.getClient(cfg);
    const remotePath = cfg.remotePath || '/';
    const entries: RemoteFileEntry[] = [];

    try {
      const items = await client.getDirectoryContents(remotePath, { deep: true });
      const list = Array.isArray(items) ? items : [];
      for (const item of list) {
        if (item.type === 'file') {
          const relPath = item.filename.replace(remotePath, '').replace(/^\//, '');
          if (this.shouldIgnore(relPath, cfg.ignorePatterns || [])) continue;
          entries.push({
            path: relPath,
            size: item.size || 0,
            lastModified: item.lastmod || new Date().toISOString(),
            etag: item.etag || undefined,
          });
        }
      }
    } catch {
      /* empty */
    }

    return entries;
  }

  async pull(ctx: SyncContext): Promise<PullResult> {
    const cfg = (ctx.options as any).adapterConfig as WebDAVAdapterConfig;
    const client = this.getClient(cfg);
    const remotePath = cfg.remotePath || '/';
    const result: PullResult = { filesUpdated: 0, filesDeleted: 0, errors: [] };

    try {
      const remoteFiles = await this.listRemote(cfg);
      for (const remote of remoteFiles) {
        const localPath = path.join(ctx.projectPath, remote.path);
        try {
          // Check if local needs update
          let needsUpdate = true;
          if (fs.existsSync(localPath)) {
            const stat = fs.statSync(localPath);
            const localMtime = stat.mtime.getTime();
            const remoteMtime = new Date(remote.lastModified).getTime();
            if (localMtime >= remoteMtime) needsUpdate = false;
          }
          if (!needsUpdate) continue;

          // Download
          const dir = path.dirname(localPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const content = await client.getFileContents(path.posix.join(remotePath, remote.path));
          // T9: pull 时检测加密格式并解密
          const keyring = getKeyring();
          const decrypted = maybeDecryptContent(Buffer.from(content as Uint8Array), keyring);
          fs.writeFileSync(localPath, decrypted);
          result.filesUpdated++;
        } catch (e: unknown) {
          result.errors.push(
            `${remote.path}: ${e instanceof Error ? e.message : 'download failed'}`,
          );
        }
      }
    } catch (e: unknown) {
      result.errors.push(e instanceof Error ? e.message : 'Pull failed');
    }

    return result;
  }

  async push(ctx: SyncContext): Promise<PushResult> {
    const cfg = (ctx.options as any).adapterConfig as WebDAVAdapterConfig;
    const client = this.getClient(cfg);
    const remotePath = cfg.remotePath || '/';
    const result: PushResult = { filesPushed: 0, errors: [] };

    try {
      for (const change of ctx.changedFiles) {
        const remoteFilePath = path.posix.join(remotePath, change.path);
        try {
          if (change.type === 'deleted') {
            await client.deleteFile(remoteFilePath);
          } else {
            // Ensure parent directory exists
            const dir = path.posix.dirname(remoteFilePath);
            if (dir !== remotePath) {
              await this.ensureRemoteDir(client, dir);
            }
            const localPath = path.join(ctx.projectPath, change.path);
            const content = fs.readFileSync(localPath);
            // T9: push 时若 keyring 已 unlock 则加密
            const keyring = getKeyring();
            const output = maybeEncryptContent(content, keyring);
            await client.putFileContents(remoteFilePath, output, { overwrite: true });
            result.filesPushed++;
          }
        } catch (e: unknown) {
          result.errors.push(`${change.path}: ${e instanceof Error ? e.message : 'upload failed'}`);
        }
      }
    } catch (e: unknown) {
      result.errors.push(e instanceof Error ? e.message : 'Push failed');
    }

    return result;
  }

  private async ensureRemoteDir(client: WebDAVClient, dirPath: string): Promise<void> {
    try {
      await client.createDirectory(dirPath, { recursive: true });
    } catch {
      /* may already exist */
    }
  }

  private shouldIgnore(filePath: string, patterns: string[]): boolean {
    return patterns.some((p) => {
      if (p.endsWith('/')) return filePath.startsWith(p);
      if (p.startsWith('*')) return filePath.endsWith(p.slice(1));
      return filePath.includes(p);
    });
  }
}
