/**
 * PWA Service Worker 注册协议检测
 *
 * 浏览器安全限制：Service Worker 仅在 HTTPS 或 localhost 下可注册。
 * LAN IP（如 192.168.x.x）走 HTTP 时 `navigator.serviceWorker.register` 会抛错，
 * PWA 离线能力不可用。
 *
 * 该模块提供纯函数，供：
 *   - 浏览器侧 `packages/core/src/web/js/common.js` 中的 SW 注册逻辑参考（保持同步）
 *   - 服务端 / 测试侧直接 import 用于单元测试
 *
 * 注意：common.js 是传统浏览器脚本（非 ESM），无法直接 import 本文件。
 * 修改本文件时务必同步更新 common.js 中的 `shouldRegisterSW` 内联实现。
 */

/**
 * 判断当前协议 + 主机名是否允许注册 Service Worker
 *
 * @param protocol location.protocol，例如 'https:' / 'http:'
 * @param hostname location.hostname，例如 '127.0.0.1' / '192.168.1.10' / 'localhost'
 * @returns allowed=true 可注册；allowed=false 时 reason 给出跳过原因
 */
export function shouldRegisterServiceWorker(
  protocol: string,
  hostname: string,
): { allowed: boolean; reason?: string } {
  // HTTPS 总是允许
  if (protocol === 'https:') {
    return { allowed: true };
  }

  // localhost / 127.0.0.1 / ::1 视为安全上下文（即使是 HTTP）
  // 注意：这里只判断 hostname，不解析 IPv4/IPv6 全部回环段（127.x.x.x / fc00::/7），
  // 因为浏览器对 localhost 的安全判定也仅限这几个常见主机名。
  const safeHostnames = new Set(['localhost', '127.0.0.1', '::1']);
  if (safeHostnames.has(hostname)) {
    return { allowed: true };
  }

  // ��他场景（典型：http://192.168.x.x）不支持 SW 注册
  return {
    allowed: false,
    reason:
      'PWA Service Worker 仅在 HTTPS 或 localhost 下可注册。当前通过 HTTP + LAN IP 访问，已跳过 SW 注册。请使用 localhost 或通过 HTTPS 隧道访问以启用离线能力。',
  };
}
