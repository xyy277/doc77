import type { Request } from 'express';

/**
 * 检测请求是否来自移动设备。
 * 逻辑：UA 正则匹配 + Cookie 手动覆盖。
 */
export function isMobileRequest(req: Request): boolean {
  // Cookie 覆盖：用户主动选择桌面版时返回 false
  if (getCookie(req, 'doc77-desktop') === '1') return false;

  const ua = (req.headers['user-agent'] || '').toLowerCase();
  // "Mobi" 覆盖所有手机浏览器（iOS Safari / Android Chrome / Firefox 等）
  // "Android" 兜底覆盖不带 "Mobi" 的 Android 平板 UA
  return /\bmobi|android/i.test(ua);
}

/**
 * 内联 Cookie 解析 — 不引入 cookie-parser 依赖。
 */
function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
