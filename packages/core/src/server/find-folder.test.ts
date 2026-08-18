import { describe, it, expect } from 'vitest';
import { findFoldersByFingerprintWithDeps, type FindFolderDeps } from './find-folder.js';

const fp = [
  { name: 'README.md', size: 100, type: 'file' },
  { name: 'src', size: 0, type: 'directory' },
];

function makeDeps(overrides?: Partial<FindFolderDeps>): FindFolderDeps {
  return {
    findFolders: async (root) => {
      if (root === '/slow') {
        // 模拟慢 root：超过 deadline 才返回
        await new Promise((r) => setTimeout(r, 500));
        return [];
      }
      if (root === '/fail') throw new Error('find failed');
      return ['/home/user/myproj', '/home/user/myproj/other', '/home/user/unrelated'];
    },
    stat: async (p) => {
      // 仅"真实"项目目录（myproj）下存在 fingerprint 条目；other 是子目录
      // Windows CI 回归（v1.1.9）：实现用 path.join 拼接 → Windows 反斜杠
      // 路径匹配不上硬编码正斜杠 → 全部 ENOENT。用平台无关分隔符正则
      const isReal = /[\\/]myproj[\\/]/.test(p);
      const base = p.split(/[\\/]/).pop() || '';
      if (isReal && base === 'README.md') {
        return { isFile: () => true, isDirectory: () => false, size: 100 } as ReturnType<
          FindFolderDeps['stat']
        > extends Promise<infer S>
          ? S
          : never;
      }
      if (isReal && base === 'src') {
        return { isFile: () => false, isDirectory: () => true, size: 0 } as never;
      }
      throw new Error('ENOENT');
    },
    ...overrides,
  };
}

describe('findFoldersByFingerprint（红队异步化）', () => {
  it('命中：指纹匹配的目录按分数排序去重', async () => {
    const results = await findFoldersByFingerprintWithDeps(['/home'], 'myproj', fp, makeDeps(), {
      perRootTimeoutMs: 4000,
      overallDeadline: Date.now() + 8000,
      maxCandidates: 500,
      maxConcurrency: 8,
    });
    expect(results[0].path).toBe('/home/user/myproj');
    expect(results[0].score).toBe(1);
    // 无匹配目录不进结果
    expect(results.some((r) => r.path.endsWith('unrelated'))).toBe(false);
  });

  it('root 失败不阻断其他 root（Promise.allSettled 隔离）', async () => {
    const results = await findFoldersByFingerprintWithDeps(
      ['/fail', '/home'],
      'myproj',
      fp,
      makeDeps(),
      {
        perRootTimeoutMs: 4000,
        overallDeadline: Date.now() + 8000,
        maxCandidates: 500,
        maxConcurrency: 8,
      },
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('deadline 已过时不再校验候选（提前返回）', async () => {
    const results = await findFoldersByFingerprintWithDeps(['/home'], 'myproj', fp, makeDeps(), {
      perRootTimeoutMs: 4000,
      overallDeadline: Date.now() - 1,
      maxCandidates: 500,
      maxConcurrency: 8,
    });
    expect(Array.isArray(results)).toBe(true);
  });

  it('并发上限：同一时刻 stat 并发数不超过 maxConcurrency', async () => {
    let concurrent = 0;
    let peak = 0;
    const deps = makeDeps({
      stat: async (p) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        const base = p.split('/').pop() || '';
        if (base === 'README.md') {
          return { isFile: () => true, isDirectory: () => false, size: 100 } as never;
        }
        if (base === 'src') {
          return { isFile: () => false, isDirectory: () => true, size: 0 } as never;
        }
        throw new Error('ENOENT');
      },
    });
    await findFoldersByFingerprintWithDeps(['/home'], 'myproj', fp, deps, {
      perRootTimeoutMs: 4000,
      overallDeadline: Date.now() + 8000,
      maxCandidates: 500,
      maxConcurrency: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
