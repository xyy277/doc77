import { describe, it, expect } from 'vitest';
import { shouldRegisterServiceWorker } from '../src/pwa/sw-policy.js';

/**
 * T7 — PWA Service Worker HTTP 限制
 *
 * 验证协议检测纯函数在各种 protocol + hostname 组合下是否正确判断
 * 是否应注册 Service Worker。
 */
describe('shouldRegisterServiceWorker', () => {
  it('允许 HTTPS 协议（任意主机名）', () => {
    expect(shouldRegisterServiceWorker('https:', 'example.com')).toEqual({ allowed: true });
    expect(shouldRegisterServiceWorker('https:', '192.168.1.10')).toEqual({ allowed: true });
    expect(shouldRegisterServiceWorker('https:', 'localhost')).toEqual({ allowed: true });
  });

  it('允许 HTTP + localhost', () => {
    expect(shouldRegisterServiceWorker('http:', 'localhost')).toEqual({ allowed: true });
  });

  it('允许 HTTP + 127.0.0.1', () => {
    expect(shouldRegisterServiceWorker('http:', '127.0.0.1')).toEqual({ allowed: true });
  });

  it('允许 HTTP + ::1 (IPv6 回环)', () => {
    expect(shouldRegisterServiceWorker('http:', '::1')).toEqual({ allowed: true });
  });

  it('拒绝 HTTP + LAN IP（典型场景：192.168.x.x）', () => {
    const result = shouldRegisterServiceWorker('http:', '192.168.1.10');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toMatch(/HTTPS|localhost|隧道/);
  });

  it('拒绝 HTTP + 其他主机名（含公网域名）', () => {
    const result = shouldRegisterServiceWorker('http:', 'example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('拒绝 HTTP + 127.0.0.2（虽是回环段但浏览器仅放行 127.0.0.1）', () => {
    // 浏览器对 localhost 的判定只覆盖 127.0.0.1，不含 127.x 段其他地址
    const result = shouldRegisterServiceWorker('http:', '127.0.0.2');
    expect(result.allowed).toBe(false);
  });

  it('拒绝时 reason 为中文说明（便于控制台 warn 阅读理解）', () => {
    const result = shouldRegisterServiceWorker('http:', '10.0.0.5');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/PWA Service Worker/);
  });
});
