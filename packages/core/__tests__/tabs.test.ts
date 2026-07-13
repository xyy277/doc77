import { describe, test, expect } from 'vitest';
// tabs.js is a UMD browser module; default import gives module.exports
import TabStore from '../src/web/js/tabs.js';

const { createTabStore } = TabStore as {
  createTabStore: (opts?: { maxTabs?: number; maxRendered?: number }) => any;
};

describe('createTabStore — tab list management', () => {
  test('open adds a tab and makes it active', () => {
    const s = createTabStore();
    const r = s.open('a.md', 'a.md');
    expect(s.list().map((t: any) => t.path)).toEqual(['a.md']);
    expect(s.activePath()).toBe('a.md');
    expect(r.evicted).toEqual([]);
  });

  test('opening an already-open path does not duplicate but activates it', () => {
    const s = createTabStore();
    s.open('a.md', 'a.md');
    s.open('b.md', 'b.md');
    s.open('a.md', 'a.md');
    expect(s.list().map((t: any) => t.path)).toEqual(['a.md', 'b.md']);
    expect(s.activePath()).toBe('a.md');
  });

  test('reaching the tab cap evicts the least-recently-used non-active tab', () => {
    const s = createTabStore({ maxTabs: 3 });
    s.open('a', 'a'); // active a
    s.open('b', 'b'); // active b
    s.open('c', 'c'); // active c ; touch order: a < b < c
    const r = s.open('d', 'd'); // over cap -> evict LRU non-active = a
    expect(r.evicted).toEqual(['a']);
    expect(s.list().map((t: any) => t.path)).toEqual(['b', 'c', 'd']);
    expect(s.activePath()).toBe('d');
  });

  test('cap eviction never removes the active tab', () => {
    const s = createTabStore({ maxTabs: 2 });
    s.open('a', 'a');
    s.open('b', 'b');
    s.activate('a'); // active a, touch order: b < a
    const r = s.open('c', 'c'); // evict LRU non-active = b (not active a)
    expect(r.evicted).toEqual(['b']);
    expect(s.list().map((t: any) => t.path)).toEqual(['a', 'c']);
  });

  test('closing the active tab activates the right neighbor', () => {
    const s = createTabStore();
    s.open('a', 'a');
    s.open('b', 'b');
    s.open('c', 'c');
    s.activate('b');
    const r = s.close('b');
    expect(r.active).toBe('c');
    expect(s.list().map((t: any) => t.path)).toEqual(['a', 'c']);
  });

  test('closing the active last tab activates the left neighbor', () => {
    const s = createTabStore();
    s.open('a', 'a');
    s.open('b', 'b');
    s.open('c', 'c'); // active c (rightmost)
    const r = s.close('c');
    expect(r.active).toBe('b');
    expect(s.list().map((t: any) => t.path)).toEqual(['a', 'b']);
  });

  test('closing a non-active tab leaves the active tab unchanged', () => {
    const s = createTabStore();
    s.open('a', 'a');
    s.open('b', 'b');
    s.activate('a');
    const r = s.close('b');
    expect(r.active).toBe('a');
    expect(s.activePath()).toBe('a');
  });

  test('closing the only tab leaves no active tab', () => {
    const s = createTabStore();
    s.open('a', 'a');
    const r = s.close('a');
    expect(r.active).toBe(null);
    expect(s.list()).toEqual([]);
    expect(s.activePath()).toBe(null);
  });
});

describe('createTabStore — rendered-DOM LRU', () => {
  test('noteRendered evicts the least-recently-rendered path over the cap', () => {
    const s = createTabStore({ maxRendered: 2 });
    expect(s.noteRendered('a')).toBe(null);
    expect(s.noteRendered('b')).toBe(null);
    expect(s.noteRendered('c')).toBe('a'); // a is LRU -> evicted
    expect(s.renderedList()).toEqual(['b', 'c']);
  });

  test('re-noting a rendered path refreshes it as most-recently-used', () => {
    const s = createTabStore({ maxRendered: 2 });
    s.noteRendered('a');
    s.noteRendered('b');
    s.noteRendered('a'); // refresh a -> order b < a
    expect(s.noteRendered('c')).toBe('b'); // now b is LRU
    expect(s.renderedList()).toEqual(['a', 'c']);
  });

  test('dropRendered removes a path from the rendered set', () => {
    const s = createTabStore({ maxRendered: 3 });
    s.noteRendered('a');
    s.noteRendered('b');
    s.dropRendered('a');
    expect(s.renderedList()).toEqual(['b']);
  });

  test('closing a tab also drops it from the rendered set', () => {
    const s = createTabStore({ maxRendered: 3 });
    s.open('a', 'a');
    s.open('b', 'b');
    s.noteRendered('a');
    s.noteRendered('b');
    s.close('a');
    expect(s.renderedList()).toEqual(['b']);
  });
});
