/**
 * S3 sync adapter — AWS S3, MinIO, Cloudflare R2, Backblaze B2.
 *
 * T9 E2EE: 若 keyring 已 unlock，push 时加密文件内容，pull 时自动解密。
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
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

export interface S3AdapterConfig extends AdapterConfig {
  type: 's3';
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  ignorePatterns: string[];
}

export class S3Adapter implements SyncAdapter {
  readonly name = 's3';
  readonly displayName = 'S3 / Object Storage';

  private getClient(config: S3AdapterConfig): S3Client {
    return new S3Client({
      region: config.region || 'us-east-1',
      endpoint: config.endpoint || undefined,
      forcePathStyle: !!config.endpoint, // Required for MinIO
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async testConnection(config: AdapterConfig): Promise<ConnectionResult> {
    const cfg = config as S3AdapterConfig;
    try {
      const client = this.getClient(cfg);
      const result = await client.send(
        new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.prefix || '', MaxKeys: 1 }),
      );
      return {
        ok: true,
        message: `Connected to bucket "${cfg.bucket}". KeyCount: ${result.KeyCount ?? 0}`,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      if (msg.includes('AccessDenied'))
        return { ok: false, message: 'Access denied — check credentials' };
      if (msg.includes('NoSuchBucket'))
        return { ok: false, message: `Bucket "${cfg.bucket}" not found` };
      return { ok: false, message: msg };
    }
  }

  async listRemote(config: AdapterConfig): Promise<RemoteFileEntry[]> {
    const cfg = config as S3AdapterConfig;
    const client = this.getClient(cfg);
    const prefix = cfg.prefix || '';
    const entries: RemoteFileEntry[] = [];

    try {
      let continuationToken: string | undefined;
      do {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of result.Contents || []) {
          if (!obj.Key) continue;
          const relPath = obj.Key.slice(prefix.length);
          if (!relPath || relPath.endsWith('/')) continue; // skip dirs
          if (this.shouldIgnore(relPath, cfg.ignorePatterns || [])) continue;
          entries.push({
            path: relPath,
            size: obj.Size || 0,
            lastModified: obj.LastModified?.toISOString() || new Date().toISOString(),
            etag: obj.ETag?.replace(/"/g, ''),
          });
        }
        continuationToken = result.NextContinuationToken;
      } while (continuationToken);
    } catch {
      /* empty */
    }

    return entries;
  }

  async pull(ctx: SyncContext): Promise<PullResult> {
    const cfg = (ctx.options as any).adapterConfig as S3AdapterConfig;
    const client = this.getClient(cfg);
    const prefix = cfg.prefix || '';
    const result: PullResult = { filesUpdated: 0, filesDeleted: 0, errors: [] };

    try {
      const remoteFiles = await this.listRemote(cfg);
      for (const remote of remoteFiles) {
        const localPath = path.join(ctx.projectPath, remote.path);
        try {
          let needsUpdate = true;
          if (fs.existsSync(localPath)) {
            const stat = fs.statSync(localPath);
            if (stat.mtime.getTime() >= new Date(remote.lastModified).getTime())
              needsUpdate = false;
          }
          if (!needsUpdate) continue;

          const dir = path.dirname(localPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

          const response = await client.send(
            new GetObjectCommand({ Bucket: cfg.bucket, Key: prefix + remote.path }),
          );
          const body = response.Body;
          if (body) {
            const bytes = await body.transformToByteArray();
            // T9: pull 时检测加密格式并解密
            const keyring = getKeyring();
            const decrypted = maybeDecryptContent(Buffer.from(bytes), keyring);
            fs.writeFileSync(localPath, decrypted);
            result.filesUpdated++;
          }
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
    const cfg = (ctx.options as any).adapterConfig as S3AdapterConfig;
    const client = this.getClient(cfg);
    const prefix = cfg.prefix || '';
    const result: PushResult = { filesPushed: 0, errors: [] };

    try {
      for (const change of ctx.changedFiles) {
        const key = prefix + change.path;
        try {
          if (change.type === 'deleted') {
            await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
          } else {
            const localPath = path.join(ctx.projectPath, change.path);
            const body = fs.readFileSync(localPath);
            // T9: push 时若 keyring 已 unlock 则加密
            const keyring = getKeyring();
            const output = maybeEncryptContent(body, keyring);
            await client.send(
              new PutObjectCommand({
                Bucket: cfg.bucket,
                Key: key,
                Body: output,
                Metadata: { 'doc77-mtime': new Date().toISOString() },
              }),
            );
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

  private shouldIgnore(filePath: string, patterns: string[]): boolean {
    return patterns.some((p) => {
      if (p.endsWith('/')) return filePath.startsWith(p);
      if (p.startsWith('*')) return filePath.endsWith(p.slice(1));
      return filePath.includes(p);
    });
  }
}
