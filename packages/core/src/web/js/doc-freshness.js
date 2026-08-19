/**
 * doc-freshness.js — preview 多 tab 内容新鲜度判定纯函数。
 *
 * 外部修改检测（SSE file-tree:changed / 目录树刷新兜底）只负责"判定 + 置标志"，
 * 自动重载的决策与 mtime 比较收敛在此模块，便于 vitest 单测与 preview.js 共用。
 *
 * UMD wrapper: exposed as global `window.Doc77Fresh` in the browser; imported as a
 * CommonJS module in vitest.
 */
(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.Doc77Fresh = api;
})(
  typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null,
  function () {
    'use strict';

    /**
     * ISO 字符串 mtime 比较：a 比 b 新？任一为空 → 视为"未知/未变"，不触发刷新。
     * 服务端树条目与 /api/content 的 modified 均为同格式 `stats.mtime.toISOString()`，
     * 字典序比较即时间序比较。
     */
    function isNewer(a, b) {
      return !!a && !!b && a > b;
    }

    /**
     * 活动 tab 外部修改自动重载决策。
     * @param {{isActiveTab: boolean, editMode: boolean, editDirty: boolean, pageHidden: boolean}} state
     * @returns {{decision: 'schedule'|'skip', reason: string|null}}
     *   skip 的 reason：'background'（后台 tab，切回激活时消费）/ 'editing'（编辑中不打断）
     *   / 'hidden'（页面隐藏，恢复可见时补发）
     */
    function autoReloadDecision(state) {
      if (state.isActiveTab === false) return { decision: 'skip', reason: 'background' };
      if (state.editMode || state.editDirty) return { decision: 'skip', reason: 'editing' };
      if (state.pageHidden) return { decision: 'skip', reason: 'hidden' };
      return { decision: 'schedule', reason: null };
    }

    return { isNewer: isNewer, autoReloadDecision: autoReloadDecision };
  },
);
