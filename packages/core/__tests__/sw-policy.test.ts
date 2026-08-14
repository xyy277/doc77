import { describe, it, expect, beforeEach } from 'vitest';
// 副作用导入：sw-policy.js 为 UMD-lite（importScripts 兼容），挂载到 globalThis.swPolicy
import '../src/web/js/sw-policy.js';

interface SwPolicy {
  shouldIntercept: (pathname: string) => boolean;
  isGetMethod: (method: string) => boolean;
  isFreshRequest: (headers: { get: (k: string) => string | null }) => boolean;
}

function getPolicy(): SwPolicy {
  const p = (globalThis as Record<string, unknown>).swPolicy;
  if (!p) {
    throw new Error('sw-policy.js 未挂载到 globalThis（UMD-lite 的 ESM 分支未执行）');
  }
  return p as SwPolicy;
}

/**
 * SW 拦截策略纯函数
 *
 * 验证三个决策：
 *   1. 仅 /api/tree/ 与 /api/content/ 前缀进入离线缓存（/api/raw 等其余 API 不受 SW 干扰）
 *   2. 仅 GET/HEAD 允许走 Cache API（cache.put 对非 GET 响应抛异常——
 *      这是新建/重命名/删除误报 503 {"error":"offline"} 的根因）
 *   3. x-doc77-fresh: 1 标记的刷新请求跳过 SWR 直接网络优先
 */
describe('sw-policy（Service Worker 拦截策略）', () => {
  let policy: SwPolicy;

  beforeEach(() => {
    policy = getPolicy();
  });

  it('拦截 /api/tree/ 与 /api/content/ 前缀', () => {
    expect(policy.shouldIntercept('/api/tree/1?path=docs')).toBe(true);
    expect(policy.shouldIntercept('/api/tree/1')).toBe(true);
    expect(policy.shouldIntercept('/api/content/1?path=a.md')).toBe(true);
  });

  it('不拦截其他路径（含 /api/raw、SSE、sync 与静态资源）', () => {
    expect(policy.shouldIntercept('/api/raw/1?path=a.md')).toBe(false);
    expect(policy.shouldIntercept('/api/events')).toBe(false);
    expect(policy.shouldIntercept('/api/sync/state')).toBe(false);
    expect(policy.shouldIntercept('/api/projects')).toBe(false);
    expect(policy.shouldIntercept('/css/app.css')).toBe(false);
    expect(policy.shouldIntercept('/js/preview.js')).toBe(false);
    expect(policy.shouldIntercept('/')).toBe(false);
  });

  it('仅 GET/HEAD 视为可缓存请求', () => {
    expect(policy.isGetMethod('GET')).toBe(true);
    expect(policy.isGetMethod('HEAD')).toBe(true);
    expect(policy.isGetMethod('POST')).toBe(false);
    expect(policy.isGetMethod('PUT')).toBe(false);
    expect(policy.isGetMethod('DELETE')).toBe(false);
  });

  it('x-doc77-fresh: 1 为刷新请求（跳过 SWR 网络优先）', () => {
    const fresh = { get: (k: string) => (k === 'x-doc77-fresh' ? '1' : null) };
    const absent = { get: () => null };
    const other = { get: (k: string) => (k === 'x-doc77-fresh' ? '0' : null) };
    expect(policy.isFreshRequest(fresh)).toBe(true);
    expect(policy.isFreshRequest(absent)).toBe(false);
    expect(policy.isFreshRequest(other)).toBe(false);
  });
});
