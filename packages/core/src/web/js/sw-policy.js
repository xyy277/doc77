/**
 * Doc77 Service Worker 拦截策略 — 纯函数
 *
 * 同时供 sw.js（importScripts 经典脚本）与单元测试（vitest ESM）使用。
 * 挂载到 self/globalThis.swPolicy：本文件不含 export / module.exports（importScripts
 * 不支持 ESM，而 module 分支会让 Vite 的 CJS 检测产生歧义），vitest 侧以副作用
 * 导入后从 globalThis.swPolicy 读取。
 */
(function (root, factory) {
  root.swPolicy = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 需要走离线缓存的文档类 API 前缀 */
  var API_PREFIXES = ['/api/tree/', '/api/content/'];

  /** 该 pathname 是否属于 SW 缓存的文档类 API */
  function shouldIntercept(pathname) {
    return API_PREFIXES.some(function (p) {
      return pathname.indexOf(p) === 0;
    });
  }

  /** 仅 GET/HEAD 可写入 Cache API（cache.put 对非 GET 响应抛异常） */
  function isGetMethod(method) {
    return method === 'GET' || method === 'HEAD';
  }

  /**
   * 刷新类请求（SSE 事件 / 手动刷新）携带 x-doc77-fresh: 1，
   * 跳过 SWR 直接网络优先，避免渲染缓存旧数据
   */
  function isFreshRequest(headers) {
    return typeof headers.get === 'function' && headers.get('x-doc77-fresh') === '1';
  }

  /**
   * 变更类请求（非 GET）的缓存清除前缀。
   *
   * 返回该项目范围的 /api/tree/<id> 或 /api/content/<id>：该前缀下的
   * SWR 缓存条目（Cache API + IndexedDB）必须在变更生效时清除，否则
   * 下次普通 GET 会命中变更前的旧目录/旧内容（如已删除文件仍显示在树上）。
   * 无项目范围的路径返回 null（不拦截）。
   */
  function getMutationPurgePrefix(pathname) {
    var m = /^\/api\/(tree|content)\/(\d+)/.exec(pathname);
    return m ? '/api/' + m[1] + '/' + m[2] : null;
  }

  return {
    shouldIntercept: shouldIntercept,
    isGetMethod: isGetMethod,
    isFreshRequest: isFreshRequest,
    getMutationPurgePrefix: getMutationPurgePrefix,
  };
});
