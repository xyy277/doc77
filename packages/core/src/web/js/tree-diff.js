/**
 * Doc77 目录树增量 diff — 纯函数
 *
 * 同时供 preview.js（浏览器）与单元测试（vitest ESM）使用。
 * 挂载到 self/globalThis.Doc77TreeDiff（与 sw-policy.js 相同的 UMD-lite 约定：
 * 不含 export，vitest 以副作用导入后从 globalThis 读取）。
 */
(function (root, factory) {
  root.Doc77TreeDiff = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 两条目是否可视为同一（name 相同 + type/size/modified 全等） */
  function sameEntry(a, b) {
    return a.type === b.type && a.size === b.size && a.modified === b.modified;
  }

  /**
   * 对比新旧目录条目（按 name 对齐）：
   *   added   — 新出现的条目（含 name 相同但 type 变化的）
   *   removed — 消失的条目 name（保持旧顺序）
   *   updated — name 相同但 type/size/modified 有变化（值为新条目）
   * 返回数组顺序与输入一致（顺序稳定，便于 DOM 按序插入）。
   */
  function diffEntries(oldEntries, newEntries) {
    oldEntries = oldEntries || [];
    newEntries = newEntries || [];
    var oldByName = {};
    oldEntries.forEach(function (e) { oldByName[e.name] = e; });
    var newByName = {};
    newEntries.forEach(function (e) { newByName[e.name] = e; });

    var added = [], updated = [], removed = [];
    newEntries.forEach(function (e) {
      var old = oldByName[e.name];
      if (!old) added.push(e);
      else if (!sameEntry(old, e)) updated.push(e);
    });
    oldEntries.forEach(function (e) {
      if (!newByName[e.name]) removed.push(e.name);
    });
    return { added: added, removed: removed, updated: updated };
  }

  return { diffEntries: diffEntries };
});
