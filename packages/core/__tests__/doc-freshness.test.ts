import { describe, test, expect } from 'vitest';
// @ts-expect-error - JS file without types
import Doc77Fresh from '../src/web/js/doc-freshness.js';

const { isNewer, autoReloadDecision } = Doc77Fresh as {
  isNewer: (a: string | undefined, b: string | undefined) => boolean;
  autoReloadDecision: (state: {
    isActiveTab: boolean;
    editMode: boolean;
    editDirty: boolean;
    pageHidden: boolean;
  }) => { decision: 'schedule' | 'skip'; reason: string | null };
};

describe('Doc77Fresh — isNewer (ISO mtime 字典序比较)', () => {
  test('新时间 → true，相等 → false，旧时间 → false', () => {
    const newer = '2026-08-19T10:00:00.000Z';
    const older = '2026-08-19T09:00:00.000Z';
    expect(isNewer(newer, older)).toBe(true);
    expect(isNewer(older, newer)).toBe(false);
    expect(isNewer(newer, newer)).toBe(false);
  });

  test('任一为空（未知）→ false，不触发刷新', () => {
    expect(isNewer('', '2026-08-19T10:00:00.000Z')).toBe(false);
    expect(isNewer('2026-08-19T10:00:00.000Z', '')).toBe(false);
    expect(isNewer(undefined, '2026-08-19T10:00:00.000Z')).toBe(false);
    expect(isNewer('2026-08-19T10:00:00.000Z', undefined)).toBe(false);
    expect(isNewer('', '')).toBe(false);
  });

  test('同日不同毫秒精度也能区分', () => {
    expect(isNewer('2026-08-19T10:00:00.123Z', '2026-08-19T10:00:00.120Z')).toBe(true);
  });
});

describe('Doc77Fresh — autoReloadDecision（活动 tab 自动重载决策）', () => {
  const clean = { isActiveTab: true, editMode: false, editDirty: false, pageHidden: false };

  test('活动 tab + 非编辑 + 页面可见 → schedule', () => {
    const d = autoReloadDecision(clean);
    expect(d.decision).toBe('schedule');
    expect(d.reason).toBeNull();
  });

  test('后台 tab → skip(background)', () => {
    const d = autoReloadDecision({ ...clean, isActiveTab: false });
    expect(d.decision).toBe('skip');
    expect(d.reason).toBe('background');
  });

  test('编辑模式 → skip(editing)，不打断编辑', () => {
    expect(autoReloadDecision({ ...clean, editMode: true }).reason).toBe('editing');
    expect(autoReloadDecision({ ...clean, editDirty: true }).reason).toBe('editing');
    expect(autoReloadDecision({ ...clean, editMode: true, editDirty: true }).reason).toBe(
      'editing',
    );
  });

  test('页面隐藏 → skip(hidden)，恢复可见时补发', () => {
    const d = autoReloadDecision({ ...clean, pageHidden: true });
    expect(d.decision).toBe('skip');
    expect(d.reason).toBe('hidden');
  });
});
