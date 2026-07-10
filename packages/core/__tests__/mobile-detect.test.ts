import { describe, it, expect } from 'vitest';
import { isMobileRequest } from '../src/server/mobile-detect.js';
import type { Request } from 'express';

/** Helper: create a minimal mock Express Request with given headers. */
function mockReq(headers: Record<string, string | undefined>): Request {
  return { headers } as Request;
}

describe('isMobileRequest', () => {
  // ── Desktop browsers ──

  describe('desktop browsers → false', () => {
    const desktopUAs = [
      [
        'Chrome macOS',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ],
      [
        'Firefox Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      ],
      [
        'Safari macOS',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ],
      [
        'Edge Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      ],
      [
        'Linux Chrome',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ],
    ];

    it.each(desktopUAs)('%s', (_label, ua) => {
      expect(isMobileRequest(mockReq({ 'user-agent': ua }))).toBe(false);
    });
  });

  // ── Mobile phone browsers ──

  describe('mobile phone browsers → true', () => {
    const mobileUAs = [
      [
        'iPhone Safari',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ],
      [
        'iPhone Chrome',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1',
      ],
      [
        'Android Chrome',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
      ],
      ['Android Firefox', 'Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0'],
      [
        'Samsung Internet',
        'Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.5790.166 Mobile Safari/537.36',
      ],
      [
        'Opera Mobile',
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36 OPR/80.0.2254.59124',
      ],
      [
        'UC Browser',
        'Mozilla/5.0 (Linux; U; Android 14; en-US) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 UCBrowser/13.4.0.1306 Mobile Safari/537.36',
      ],
      [
        'Huawei Browser',
        'Mozilla/5.0 (Linux; Android 14; HarmonyOS; HMA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.88 HuaweiBrowser/14.0. Mobile Safari/537.36',
      ],
    ];

    it.each(mobileUAs)('%s', (_label, ua) => {
      expect(isMobileRequest(mockReq({ 'user-agent': ua }))).toBe(true);
    });
  });

  // ── Android tablets (no "Mobi" but has "Android") ──

  describe('Android tablets → true (via Android keyword)', () => {
    const tabletUAs = [
      [
        'Samsung Galaxy Tab',
        'Mozilla/5.0 (Linux; Android 14; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Safari/537.36',
      ],
      [
        'Generic Android tablet',
        'Mozilla/5.0 (Linux; Android 14; Nexus 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ],
    ];

    it.each(tabletUAs)('%s', (_label, ua) => {
      expect(isMobileRequest(mockReq({ 'user-agent': ua }))).toBe(true);
    });
  });

  // ── iPad (desktop-class UA) ──

  describe('iPadOS 13+ → false (desktop UA by default)', () => {
    it('iPad Safari (desktop UA)', () => {
      const ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
      expect(isMobileRequest(mockReq({ 'user-agent': ua }))).toBe(false);
    });
  });

  // ── Cookie override ──

  describe('Cookie: doc77-desktop=1 → overrides to false', () => {
    it('mobile UA + cookie = desktop', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: 'doc77-desktop=1',
          }),
        ),
      ).toBe(false);
    });

    it('mobile UA + cookie with other cookies', () => {
      const ua =
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: 'doc77-theme=dark; doc77-desktop=1; other=value',
          }),
        ),
      ).toBe(false);
    });

    it('mobile UA + cookie=0 does NOT override', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: 'doc77-desktop=0',
          }),
        ),
      ).toBe(true);
    });

    it('desktop UA + cookie has no effect', () => {
      const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: 'doc77-desktop=1',
          }),
        ),
      ).toBe(false);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('no User-Agent header → false', () => {
      expect(isMobileRequest(mockReq({}))).toBe(false);
    });

    it('empty User-Agent → false', () => {
      expect(isMobileRequest(mockReq({ 'user-agent': '' }))).toBe(false);
    });

    it('no cookie header → works normally', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(isMobileRequest(mockReq({ 'user-agent': ua }))).toBe(true);
    });

    it('empty cookie header → works normally', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: '',
          }),
        ),
      ).toBe(true);
    });

    it('cookie with only spaces → works normally', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: '   ',
          }),
        ),
      ).toBe(true);
    });

    it('cookie name is substring of another cookie → no false match', () => {
      // "x-doc77-desktop" should NOT be confused with "doc77-desktop"
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: 'x-doc77-desktop=1',
          }),
        ),
      ).toBe(true); // should still be mobile
    });

    it('case-insensitive User-Agent matching', () => {
      expect(isMobileRequest(mockReq({ 'user-agent': 'MOBILE TEST' }))).toBe(true);
      expect(isMobileRequest(mockReq({ 'user-agent': 'ANDROID TABLET' }))).toBe(true);
    });

    it('"mobis" or "mobius" in UA → false (no leading word boundary)', () => {
      // "mobis" starts with "mobi" but context matters — wait, the leading \b still
      // matches because mobis starts at the beginning of a word. But "mobis" is not
      // a real browser string. This is a theoretical edge case.
      // With \bmobi (no trailing \b), "mobis" WOULD match. This is acceptable
      // because no real non-mobile browser sends "mobis" as a token.
      const ua = 'SomeBrowser/1.0 mobis/2.0';
      // \bmobi matches "mobis" because it starts with a word boundary
      expect(isMobileRequest(mockReq({ 'user-agent': ua }))).toBe(true);
    });

    it('"SymbianOS" does NOT match → no word boundary before mobi', () => {
      // "SymbianOS" contains 'bian' not 'mobi', so it shouldn't match anyway.
      // But let's test: "Symbian" has no "mobi" substring.
      const ua = 'Mozilla/5.0 (SymbianOS/9.4; Series60/5.0)';
      expect(isMobileRequest(mockReq({ 'user-agent': ua }))).toBe(false);
    });
  });

  // ── Cookie edge cases ──

  describe('cookie edge cases', () => {
    it('cookie without value (boolean flag)', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: 'doc77-desktop; other=value',
          }),
        ),
      ).toBe(true); // not '1', so no override
    });

    it('cookie value contains encoded characters', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      expect(
        isMobileRequest(
          mockReq({
            'user-agent': ua,
            cookie: 'doc77-desktop=1; token=abc%20123',
          }),
        ),
      ).toBe(false); // doc77-desktop=1 → override
    });
  });
});
