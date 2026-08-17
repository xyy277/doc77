import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export interface FingerprintEntry {
  name: string;
  size: number;
  type: string;
}

export interface FolderMatch {
  path: string;
  score: number;
}

export interface FindFolderOptions {
  perRootTimeoutMs?: number;
  overallDeadlineMs?: number;
  maxCandidatesPerRoot?: number;
  maxConcurrency?: number;
}

/** 单 root 的 find + fingerprint 校验（可注入，供测试替换 find 行为） */
export interface FindFolderDeps {
  findFolders: (root: string, folderName: string, timeoutMs: number) => Promise<string[]>;
  stat: (p: string) => Promise<fs.Stats>;
}

const defaultDeps: FindFolderDeps = {
  findFolders: (root, folderName, timeoutMs) =>
    new Promise((resolve) => {
      // 安全：argv 数组无 shell（防命令注入），逐 root 独立超时
      execFile(
        'find',
        [root, '-maxdepth', '4', '-type', 'd', '-name', folderName],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf-8' },
        (err, stdout) => {
          // find 非零退出（如权限）时 stdout 可能仍有结果
          resolve(
            String(stdout || '')
              .split('\n')
              .filter(Boolean),
          );
          void err;
        },
      );
    }),
  stat: (p) => fs.promises.stat(p),
};

/**
 * 按指纹查找同名目录（红队修复：原 execFileSync 同步跑外部 find，多 root
 * 串行最坏 8-40s 全进程冻结，且任意网页可触发）。
 * - 每 root 独立 timeout，Promise.allSettled 并行（root 失败不阻断其他）
 * - 总 deadline 8s；候选截断；fingerprint 校验并发上限 8
 */
export async function findFoldersByFingerprint(
  roots: string[],
  folderName: string,
  fingerprint: FingerprintEntry[],
  opts?: FindFolderOptions,
): Promise<FolderMatch[]> {
  const perRootTimeoutMs = opts?.perRootTimeoutMs ?? 4000;
  const overallDeadline = Date.now() + (opts?.overallDeadlineMs ?? 8000);
  const maxCandidates = opts?.maxCandidatesPerRoot ?? 500;
  const maxConcurrency = opts?.maxConcurrency ?? 8;
  return findFoldersByFingerprintWithDeps(roots, folderName, fingerprint, defaultDeps, {
    perRootTimeoutMs,
    overallDeadline,
    maxCandidates,
    maxConcurrency,
  });
}

/** 依赖注入版（测试用） */
export function findFoldersByFingerprintWithDeps(
  roots: string[],
  folderName: string,
  fingerprint: FingerprintEntry[],
  deps: FindFolderDeps,
  opts: {
    perRootTimeoutMs: number;
    overallDeadline: number;
    maxCandidates: number;
    maxConcurrency: number;
  },
): Promise<FolderMatch[]> {
  return (async () => {
    const results = await Promise.allSettled(
      roots.map((root) =>
        (async () => {
          const candidates = await deps.findFolders(root, folderName, opts.perRootTimeoutMs);
          const matches: FolderMatch[] = [];
          let inFlight = 0;
          let cursor = 0;
          const run = async (candidate: string): Promise<void> => {
            if (Date.now() > opts.overallDeadline) return;
            try {
              let matched = 0;
              let checked = 0;
              for (const fp of fingerprint) {
                checked++;
                try {
                  const st = await deps.stat(path.join(candidate, fp.name));
                  if (fp.type === 'directory' && st.isDirectory()) matched++;
                  else if (fp.type === 'file' && st.isFile()) {
                    if (fp.size === 0 || st.size === fp.size || Math.abs(st.size - fp.size) < 10)
                      matched++;
                  }
                } catch {
                  /* entry 不存在 */
                }
              }
              if (checked > 0 && matched > 0) {
                matches.push({ path: candidate, score: matched / checked });
              }
            } catch {
              /* 单候选失败忽略 */
            }
          };
          // 并发上限 8 的简单工作池
          const pool: Promise<void>[] = [];
          const limited = candidates.slice(0, opts.maxCandidates);
          while (cursor < limited.length && inFlight < opts.maxConcurrency) {
            const c = limited[cursor++];
            inFlight++;
            pool.push(
              run(c).finally(() => {
                inFlight--;
                if (cursor < limited.length && Date.now() <= opts.overallDeadline) {
                  const next = limited[cursor++];
                  inFlight++;
                  pool.push(
                    run(next).finally(() => {
                      inFlight--;
                    }),
                  );
                }
              }),
            );
          }
          await Promise.all(pool);
          return matches;
        })(),
      ),
    );

    const matches = results
      .filter((r): r is PromiseFulfilledResult<FolderMatch[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    matches.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    return matches.filter((m) => {
      if (seen.has(m.path)) return false;
      seen.add(m.path);
      return true;
    });
  })();
}

/** WSL 下搜索根（Linux home + /mnt 挂载 + Users） */
export function resolveSearchRoots(): string[] {
  const roots: string[] = [];
  const home = process.env.HOME || '/home';
  roots.push(home);
  let isWsl = false;
  try {
    isWsl = /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf-8'));
  } catch {
    /* 非 Linux */
  }
  if (isWsl) {
    for (const drive of ['d', 'c', 'e']) {
      try {
        if (fs.existsSync('/mnt/' + drive)) roots.push('/mnt/' + drive);
      } catch {
        /* ignore */
      }
    }
    try {
      const usersDir = '/mnt/c/Users';
      for (const e of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          !['Public', 'Default', 'Default User', 'All Users', 'WsiAccount'].includes(e.name) &&
          !e.name.startsWith('.')
        ) {
          roots.push(usersDir + '/' + e.name);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return roots;
}
