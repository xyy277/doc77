/**
 * tabs.js — Doc77 多 tab 预览的纯逻辑层（tab 列表管理 + 渲染 DOM 的 LRU 淘汰）。
 *
 * 这里只维护顺序、活动选择、容量淘汰与「已渲染节点」的 LRU 键，不触碰 DOM。
 * preview.js 负责把这些决策落到真实 DOM（挂载/销毁内容节点、缓存 data/scrollTop）。
 *
 * UMD 包装：浏览器里作为全局 `window.TabStore`；vitest 里作为 CommonJS 模块导入。
 */
(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.TabStore = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  /**
   * @param {{maxTabs?: number, maxRendered?: number}} [opts]
   */
  function createTabStore(opts) {
    opts = opts || {};
    var maxTabs = opts.maxTabs || 8;
    var maxRendered = opts.maxRendered || 3;

    var tabs = []; // [{ path, title }]  — 顺序即 tab 栏显示顺序
    var active = null; // 当前活动 tab 的 path
    var touch = []; // path[]，最近使用排在末尾（用于 tab 容量淘汰）
    var rendered = []; // path[]，最近渲染排在末尾（用于 DOM 节点 LRU）

    function indexOf(path) {
      for (var i = 0; i < tabs.length; i++) if (tabs[i].path === path) return i;
      return -1;
    }
    function bump(arr, path) {
      var i = arr.indexOf(path);
      if (i >= 0) arr.splice(i, 1);
      arr.push(path);
    }

    /** 打开（或激活已存在的）tab。返回 { evicted: string[] }（因容量淘汰而关闭的 path）。 */
    function open(path, title) {
      var evicted = [];
      if (indexOf(path) < 0) {
        tabs.push({ path: path, title: title || path });
      } else if (title) {
        tabs[indexOf(path)].title = title;
      }
      active = path;
      bump(touch, path);

      // 超容量：淘汰最久未用的非活动 tab
      while (tabs.length > maxTabs) {
        var victim = null;
        for (var i = 0; i < touch.length; i++) {
          if (touch[i] !== active && indexOf(touch[i]) >= 0) {
            victim = touch[i];
            break;
          }
        }
        if (victim == null) break; // 只剩活动 tab，停止
        removeTab(victim);
        evicted.push(victim);
      }
      return { evicted: evicted };
    }

    /** 激活一个已存在的 tab（更新活动态与使用顺序）。 */
    function activate(path) {
      if (indexOf(path) < 0) return false;
      active = path;
      bump(touch, path);
      return true;
    }

    function removeTab(path) {
      var i = indexOf(path);
      if (i >= 0) tabs.splice(i, 1);
      var ti = touch.indexOf(path);
      if (ti >= 0) touch.splice(ti, 1);
      dropRendered(path);
    }

    /**
     * 关闭一个 tab。返回 { active, closed }。
     * 若关闭的是活动 tab，则激活相邻 tab（右侧优先，否则左侧）。
     */
    function close(path) {
      var i = indexOf(path);
      if (i < 0) return { active: active, closed: false };
      var wasActive = active === path;
      removeTab(path);
      if (wasActive) {
        if (tabs.length === 0) {
          active = null;
        } else {
          var next = tabs[i] || tabs[i - 1]; // 原位置现为右邻，否则取左邻
          active = next ? next.path : null;
          if (active) bump(touch, active);
        }
      }
      return { active: active, closed: true };
    }

    /** 记录某 path 的内容已渲染成 DOM 节点。返回因 LRU 超限而应被销毁的 path（或 null）。 */
    function noteRendered(path) {
      bump(rendered, path);
      if (rendered.length > maxRendered) {
        return rendered.shift();
      }
      return null;
    }

    /** 从「已渲染」集合中移除某 path（其 DOM 节点已被销毁）。 */
    function dropRendered(path) {
      var i = rendered.indexOf(path);
      if (i >= 0) rendered.splice(i, 1);
    }

    return {
      open: open,
      activate: activate,
      close: close,
      noteRendered: noteRendered,
      dropRendered: dropRendered,
      list: function () {
        return tabs.slice();
      },
      has: function (path) {
        return indexOf(path) >= 0;
      },
      activePath: function () {
        return active;
      },
      renderedList: function () {
        return rendered.slice();
      },
    };
  }

  return { createTabStore: createTabStore };
});
