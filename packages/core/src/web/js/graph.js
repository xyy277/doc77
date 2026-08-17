/**
 * graph.js — Doc77 知识图谱可视化（二阶段：力导向图 + 洞察）。
 *
 * 架构：
 * - 纯函数核心（不碰 DOM，vitest 可测）：buildGraphModel / colorForTag /
 *   nodeRadius / hitTest / applyViewToCtx / clampView / zoomAt
 * - DOM 层（浏览器端，守卫初始化）：Canvas 渲染 + d3-force 物理引擎
 *   （vendor 懒加载，沿用 preview.js VENDOR_MAP 模式）
 *
 * 性能约束（5000 节点硬验收：<60fps 交互 / 加载 <2s / 内存 <200MB）：
 * - Canvas 渲染（无 DOM 节点）、devicePixelRatio 上限 2、视口裁剪 + 标签上限
 * - 物理参数置顶常量便于调参；alpha 收敛后 sim.stop() 释放 CPU
 * - 孤儿淡化与 stats.orphans 语义一致（仅有断链出链的节点不在 API 孤儿集内）
 *
 * UMD 包装：浏览器里作为全局 `window.GraphViz`；vitest 里作为 CommonJS 导入。
 */
(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.GraphViz = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // Constants（物理参数经验值，冒烟时置顶调优）
  // ═══════════════════════════════════════════════════════════════

  var PHYSICS = {
    linkDistance: 60,
    chargeStrength: -150,
    chargeDistanceMax: 400, // 限制 far-field 电荷计算成本（5000 节点关键）
    centerStrength: 0.02, // 弱向心力：防孤儿/孤立组件漂移出视口
    alphaDecay: 0.045, // ~2.5s 收敛到 0.001
    velocityDecay: 0.4,
  };

  var MIN_SCALE = 0.05;
  var MAX_SCALE = 8;
  var LABEL_MIN_SCALE = 2; // 仅缩放 ≥2 时画标签
  var LABEL_MAX_COUNT = 400; // 每帧标签上限（5000 个 fillText 会掉帧）
  var INSIGHT_PAGE_SIZE = 50;
  // 大图降级阈值：≤2000 节点自动力导向（~0.4-0.6s 收敛不卡）；
  // >2000 走网格快速布局（首帧 <100ms）→ 手动"启用力导向布局"按钮。
  // 依据：2000 节点/4k 边每 tick 2-4ms，5000 节点 8-15ms/tick × 157 ticks
  // = 1.2-2.2s 毛球动画（进入卡顿根因）。
  var FORCE_AUTO_MAX_NODES = 2000;

  var PALETTE = [
    '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#f59e0b',
    '#84cc16', '#10b981', '#14b8a6', '#06b6d4', '#6366f1', '#a855f7',
  ];
  var NEUTRAL = '#94a3b8'; // 无标签节点颜色

  var D3_FORCE_URL = 'https://cdn.jsdelivr.net/npm/d3-force@3.0.0/dist/d3-force.min.js';
  // d3-force 的 UMD 不打包依赖，需按序先加载（与 vendor.ts 条目同序）
  var D3_FORCE_DEPS = [
    'https://cdn.jsdelivr.net/npm/d3-dispatch@3.0.1/dist/d3-dispatch.min.js',
    'https://cdn.jsdelivr.net/npm/d3-quadtree@3.0.1/dist/d3-quadtree.min.js',
    'https://cdn.jsdelivr.net/npm/d3-timer@3.0.1/dist/d3-timer.min.js',
  ];

  // ═══════════════════════════════════════════════════════════════
  // 纯函数核心（vitest 可测，不得引用 document/window）
  // ═══════════════════════════════════════════════════════════════

  function basename(p) {
    var s = String(p || '');
    return s.split('/').pop() || s;
  }

  function hashString(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  /** 标签 → 确定性调色板颜色（同一标签永远同色；无标签中性灰） */
  function colorForTag(tag) {
    if (!tag) return NEUTRAL;
    return PALETTE[hashString(tag) % PALETTE.length];
  }

  /** 节点半径 = 入链数的平方根缩放（3 + 8*sqrt(i/max)），clamp [3,16] */
  function nodeRadius(inLinks, maxInLinks) {
    var ratio = maxInLinks > 0 ? inLinks / maxInLinks : 0;
    var r = 3 + 8 * Math.sqrt(ratio);
    return Math.max(3, Math.min(16, r));
  }

  /**
   * 构建图模型：id = "<project_id>:<path>"（跨项目路径可碰撞，id 不冲突）。
   * - inLinks：由 resolved 边按 target 计数（与全量数据一致，客户端精确）
   * - isOrphan：与 /api/graph/orphans 列表一致（谓词见 repository.ts）
   * - 每个节点附带 radius（入链数驱动），供 hitTest/渲染直接使用
   */
  function buildGraphModel(nodes, edges, orphanRows) {
    var orphanSet = new Set();
    var rows = orphanRows || [];
    for (var i = 0; i < rows.length; i++) {
      orphanSet.add(String(rows[i].project_id) + ':' + rows[i].path);
    }
    var out = [];
    var byId = {};
    var src = nodes || [];
    for (var j = 0; j < src.length; j++) {
      var n = src[j];
      var id = String(n.project_id) + ':' + n.path;
      if (byId[id]) continue; // 防御重复
      var node = {
        id: id,
        pid: n.project_id,
        path: n.path,
        title: n.title || basename(n.path),
        tags: Array.isArray(n.tags) ? n.tags : [],
        inLinks: 0,
        isOrphan: orphanSet.has(id),
      };
      byId[id] = node;
      out.push(node);
    }
    var outEdges = [];
    var ed = edges || [];
    for (var k = 0; k < ed.length; k++) {
      var e = ed[k];
      var sid = String(e.project_id) + ':' + e.source;
      var tid = String(e.project_id) + ':' + e.target;
      if (!byId[sid] || !byId[tid]) continue; // 两端都必须在节点集内
      outEdges.push({ id: k, source: sid, target: tid, pid: e.project_id });
      byId[tid].inLinks += 1;
    }
    var maxInLinks = 0;
    for (var q = 0; q < out.length; q++) {
      if (out[q].inLinks > maxInLinks) maxInLinks = out[q].inLinks;
    }
    var orphanCount = 0;
    for (var r = 0; r < out.length; r++) {
      out[r].radius = nodeRadius(out[r].inLinks, maxInLinks);
      if (out[r].isOrphan) orphanCount++;
    }
    return { nodes: out, edges: outEdges, maxInLinks: maxInLinks, orphanCount: orphanCount };
  }

  /**
   * 大图是否自动启用力导向：nodeCount ≤ maxAutoNodes 才自动（大图降级决策）。
   * nodeCount ≤ 0 返回 true：空模型误传时不该降级到 grid。
   */
  function shouldAutoForce(nodeCount, maxAutoNodes) {
    var cap = maxAutoNodes == null ? FORCE_AUTO_MAX_NODES : maxAutoNodes;
    if (nodeCount <= 0) return true;
    return nodeCount <= cap;
  }

  /**
   * 物理参数分段（大图自适应，降低布局阶段 CPU/收敛时间）：
   * - n ≤ 1000：基线（collide 开、alphaDecay 0.045 ≈ 2.5s 收敛）
   * - 1000 < n ≤ 2000：加速（去 collide —— 每 tick 最贵的第二遍四叉树、
   *   收敛后仍抖动；decay 0.07 → tick 数减半）
   * - n > 2000（手动启用时）：更强衰减 + 更弱电荷（charge -150 × 大节点数
   *   陷入漫长互斥解缠），velocityDecay 提高防震荡
   */
  function physicsFor(nodeCount) {
    if (nodeCount > 2000) {
      return {
        linkDistance: 60,
        chargeStrength: -80,
        chargeDistanceMax: 400,
        centerStrength: 0.02,
        alphaDecay: 0.08,
        velocityDecay: 0.5,
        collide: false,
      };
    }
    if (nodeCount > 1000) {
      return {
        linkDistance: 60,
        chargeStrength: -100,
        chargeDistanceMax: 400,
        centerStrength: 0.02,
        alphaDecay: 0.07,
        velocityDecay: 0.4,
        collide: false,
      };
    }
    return {
      linkDistance: PHYSICS.linkDistance,
      chargeStrength: PHYSICS.chargeStrength,
      chargeDistanceMax: PHYSICS.chargeDistanceMax,
      centerStrength: PHYSICS.centerStrength,
      alphaDecay: PHYSICS.alphaDecay,
      velocityDecay: PHYSICS.velocityDecay,
      collide: true,
    };
  }

  /**
   * 就地应用孤儿集合（懒加载后补）：只改节点属性、不重建对象——
   * 重建会丢失 x/y/fx/fy（sim 引用与拖拽位置绑定旧对象）。幂等。
   * 返回新 orphanCount。
   */
  function applyOrphans(model, orphanRows) {
    if (!model) return 0;
    var orphanSet = new Set();
    var rows = orphanRows || [];
    for (var i = 0; i < rows.length; i++) {
      orphanSet.add(String(rows[i].project_id) + ':' + rows[i].path);
    }
    var count = 0;
    var nodes = model.nodes || [];
    for (var j = 0; j < nodes.length; j++) {
      nodes[j].isOrphan = orphanSet.has(nodes[j].id);
      if (nodes[j].isOrphan) count++;
    }
    model.orphanCount = count;
    return count;
  }

  /** 视口 → 世界矩形（margin 为世界单位；用于边裁剪/标签余量） */
  function worldRectForView(view, w, h, margin) {
    var m = margin || 0;
    var scale = view.scale || 1;
    return {
      x0: (0 - view.x) / scale - m,
      y0: (0 - view.y) / scale - m,
      x1: (w - view.x) / scale + m,
      y1: (h - view.y) / scale + m,
    };
  }

  /** 边是否可能可见：e = {x1,y1,x2,y2} 世界坐标；两端都在矩形外 → false */
  function edgePotentiallyVisible(e, rect) {
    if (!e || !rect) return true;
    var out1 = e.x1 < rect.x0 || e.x1 > rect.x1 || e.y1 < rect.y0 || e.y1 > rect.y1;
    var out2 = e.x2 < rect.x0 || e.x2 > rect.x1 || e.y2 < rect.y0 || e.y2 > rect.y1;
    return !(out1 && out2);
  }

  /**
   * 命中检测：屏幕坐标 (x,y) → 节点 id（倒序 = 最上层优先）。
   * view = {x, y, scale}（view.x/y 为屏幕平移，世界坐标 = (screen - view)/scale）
   */
  function hitTest(view, x, y, nodes) {
    var list = nodes || [];
    for (var i = list.length - 1; i >= 0; i--) {
      var n = list[i];
      if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
      var sx = view.x + n.x * view.scale;
      var sy = view.y + n.y * view.scale;
      // 命中容差随缩放换算到屏幕单位（修复前世界单位半径在 scale=8 时
      // 只能点中节点中心 ~16% 面积；scale=0.05 时产生 20px 幽灵命中区）
      var r = ((n.radius || 5) + 4) * view.scale;
      var dx = x - sx;
      var dy = y - sy;
      if (dx * dx + dy * dy <= r * r) return n.id;
    }
    return null;
  }

  /** 将 view 应用到 ctx（DPR 缩放 + 平移 + 缩放） */
  function applyViewToCtx(ctx, view, dpr) {
    ctx.setTransform(dpr || 1, 0, 0, dpr || 1, 0, 0);
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
  }

  /** 平移/缩放限制：scale ∈ [0.05, 8]，平移 ±2 视口（防图形漂出无法找回） */
  function clampView(view, w, h) {
    var m = 2;
    view.x = Math.max(-w * m, Math.min(w * m, view.x));
    view.y = Math.max(-h * m, Math.min(h * m, view.y));
    view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale));
    return view;
  }

  /** 以屏幕点 (cx,cy) 为锚缩放（锚点世界坐标保持不动） */
  function zoomAt(view, cx, cy, factor, minScale, maxScale) {
    var ns = Math.max(minScale || MIN_SCALE, Math.min(maxScale || MAX_SCALE, view.scale * factor));
    var wx = (cx - view.x) / view.scale;
    var wy = (cy - view.y) / view.scale;
    view.x = cx - wx * ns;
    view.y = cy - wy * ns;
    view.scale = ns;
    return view;
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM 层（浏览器端；导入时不得执行任何 DOM 访问）
  // ═══════════════════════════════════════════════════════════════

  // VENDOR_MAP：CDN URL 子串 → 本地 vendor 文件名（preview.js 同款精简版）
  var VENDOR_MAP = {
    'd3-dispatch.min.js': 'd3-dispatch.min.js',
    'd3-quadtree.min.js': 'd3-quadtree.min.js',
    'd3-timer.min.js': 'd3-timer.min.js',
    'd3-force.min.js': 'd3-force.min.js',
  };

  function vsrc(originalUrl, localName) {
    if (!window.__VENDOR_READY) return originalUrl;
    if (!localName) {
      for (var key in VENDOR_MAP) {
        if (originalUrl.indexOf(key) >= 0) {
          localName = VENDOR_MAP[key];
          break;
        }
      }
    }
    if (!localName) return originalUrl;
    return '/vendor/' + localName;
  }

  function vendorReady(cb) {
    if (window.__VENDOR_READY) {
      cb(true);
      return;
    }
    fetch('/vendor/.ready')
      .then(function (r) {
        window.__VENDOR_READY = r.ok;
        cb(r.ok);
      })
      .catch(function () {
        cb(false);
      });
  }

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = vsrc(src);
    s.onload = function () {
      cb(true);
    };
    s.onerror = function () {
      cb(false);
    };
    document.head.appendChild(s);
  }

  function loadD3Force(cb) {
    if (window.d3 && window.d3.forceSimulation) {
      cb(true);
      return;
    }
    // 先探测 vendor 就绪：图谱页不加载 preview.js，__VENDOR_READY 从未被
    // 设置 → vsrc 恒走 CDN（离线场景 d3 加载失败）。vendorReady 会设置该标志。
    vendorReady(function () {
      // d3-force UMD 从全局 d3 命名空间读取依赖：先按序加载 dispatch/quadtree/timer
      var chain = D3_FORCE_DEPS.slice();
      var next = function () {
        if (!chain.length) {
          loadScript(D3_FORCE_URL, function (ok) {
            cb(ok && !!(window.d3 && window.d3.forceSimulation));
          });
          return;
        }
        loadScript(chain.shift(), function (ok) {
          if (!ok) {
            cb(false);
            return;
          }
          next();
        });
      };
      next();
    });
  }

  // ── 页面状态 ──
  var state = {
    projects: [], // [{id, name}]
    selection: [], // number[]；[] = 全部
    data: null, // {graph, stats}
    insightsData: null, // {orphans[], broken[], orphanTotal, brokenTotal}（懒加载）
    model: null, // buildGraphModel 输出
    view: { x: 0, y: 0, scale: 1 },
    layoutMode: null, // 'force' | 'grid'（大图降级决策结果）
    sim: null,
    raf: null,
    dimOrphans: true,
    dark: false,
    hover: null, // hover 节点 id
    dragNode: null,
    panning: false,
    panStart: null,
    dragged: false,
    controller: null, // AbortController（取消过期请求）
    insightsController: null, // 洞察数据独立 AbortController
    insightsSeq: 0, // 洞察加载竞态守卫（复用 searchSeq 模式）
    reloadTimer: null,
    fingerprint: null, // 数据指纹（selection + 节点数 + 边数）：未变时跳过 sim 重启
    simGen: 0, // 物理引擎代次：丢弃过期 loadD3Force 回调（双 sim 竞态守卫）
    insightsTab: 'orphans',
    insightPage: 1,
    insightRows: [], // 当前 tab 的全部行（客户端分页）
  };

  function getCanvas() {
    return document.getElementById('graphCanvas');
  }

  function fetchJ(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Request failed');
        return d;
      });
    });
  }

  function isDark() {
    return document.documentElement.classList.contains('dark');
  }

  function openDoc(pid, path) {
    location.href = '/preview.html?id=' + pid + '&path=' + encodeURIComponent(path);
  }

  // ── 启动 ──
  function boot() {
    if (!document.getElementById('graphCanvas')) return; // 非 /graph 页
    // d3-force 预加载与数据请求并行（修复前数据到达后才开始串行加载 4 个
    // UMD，进入路径多一串网络往返）。回调里补显降级横幅——数据先到而
    // d3 后到时，grid 模式横幅此时才可显示（按钮依赖 d3 可用）
    loadD3Force(function () {
      if (state.layoutMode === 'grid' && state.model) {
        showForceHint(state.model.nodes.length);
      }
    });
    var ready = window.__doc77_i18n_ready || Promise.resolve();
    ready.then(function () {
      window.applyI18n && window.applyI18n(document);
      state.dark = isDark();
      setupCanvasSize();
      window.addEventListener('resize', onResize);
      bindControls();
      bindCanvasEvents();
      bindSearch();
      bindInsights();
      initSSE();
      loadProjects().then(function () {
        renderTabs();
        selectInitial();
        loadData();
      });
    });
  }

  function setupCanvasSize() {
    var canvas = getCanvas();
    if (!canvas) return;
    var wrap = canvas.parentElement;
    var dpr = Math.min(window.devicePixelRatio || 1, 2); // 上限 2：内存/性能
    canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
    canvas._dpr = dpr;
  }

  function onResize() {
    setupCanvasSize();
    scheduleDraw();
  }

  // ── 项目加载与切换 ──
  function loadProjects() {
    return fetchJ('/api/projects').then(function (d) {
      var list = Array.isArray(d) ? d : d.projects || [];
      state.projects = list.map(function (p) {
        return { id: p.id, name: p.name };
      });
      return state.projects;
    });
  }

  function projectName(pid) {
    for (var i = 0; i < state.projects.length; i++) {
      if (state.projects[i].id === pid) return state.projects[i].name;
    }
    return String(pid);
  }

  function renderTabs() {
    var nav = document.getElementById('projectTabs');
    var html = '';
    html +=
      '<button data-pid="" class="' +
      tabCls(state.selection.length === 0) +
      '">' +
      esc(t('web.graph.allProjects')) +
      '</button>';
    for (var i = 0; i < state.projects.length; i++) {
      var p = state.projects[i];
      var active = state.selection.length === 1 && state.selection[0] === p.id;
      html +=
        '<button data-pid="' + p.id + '" class="' + tabCls(active) + '">' + esc(p.name) + '</button>';
    }
    nav.innerHTML = html;
    nav.querySelectorAll('button[data-pid]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-pid');
        state.selection = v === '' ? [] : [parseInt(v, 10)];
        renderTabs();
        loadData();
      });
    });
  }

  function tabCls(active) {
    return (
      'px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors ' +
      (active
        ? 'bg-blue-500 text-white'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700')
    );
  }

  function selectInitial() {
    var m = /[?&]projects=([^&]+)/.exec(location.search);
    if (m) {
      var ids = m[1]
        .split(',')
        .map(function (s) {
          return parseInt(s, 10);
        })
        .filter(function (n) {
          return !isNaN(n) && state.projects.some(function (p) {
            return p.id === n;
          });
        });
      if (ids.length) state.selection = ids;
    }
  }

  // ── 数据加载（请求独立失败 + AbortController 网络级取消）──
  // 修复前四请求每次都全量拉取：orphans(limit=10000, ~1MB) 仅洞察面板
  // （默认隐藏）使用，重索引风暴期每秒重拉一次。现在仅当已加载过
  // （SSE 刷新保持新鲜）才随主请求并行；首载走 loadInsightsData 空闲后台加载。
  function loadData() {
    if (state.controller) state.controller.abort();
    var ctrl = (state.controller = new AbortController());
    var sel = state.selection.length ? state.selection : state.projects.map(function (p) {
      return p.id;
    });
    if (!sel.length) {
      state.data = null;
      state.model = null;
      toggleEmptyState(true);
      return;
    }
    var q = 'projects=' + sel.join(',');
    var opts = { signal: ctrl.signal };
    // 修复前 Promise.all 原子失败：一个请求挂（如重索引期 SQLITE_BUSY）
    // 整个模型被丢弃。现在 graph 独立失败才 toast，orphans/broken 失败
    // 仅降级洞察面板（canvas 用 graph 数据即可渲染）。
    var graphP = fetchJ('/api/graph?' + q, opts).catch(function (err) {
      if (!ctrl.signal.aborted) {
        window.toast && window.toast(String((err && err.message) || err), 'error');
      }
      return null;
    });
    var statsP = fetchJ('/api/graph/stats?' + q, opts).catch(function () {
      return null;
    });
    var haveInsights = !!state.insightsData;
    var orphansP = haveInsights
      ? fetchJ('/api/graph/orphans?' + q + '&limit=10000', opts).catch(function () {
          return null;
        })
      : Promise.resolve(null);
    var brokenP = haveInsights
      ? fetchJ('/api/graph/broken?' + q + '&limit=500', opts).catch(function () {
          return null;
        })
      : Promise.resolve(null);
    Promise.all([graphP, statsP, orphansP, brokenP]).then(function (res) {
      if (ctrl.signal.aborted) return;
      var graph = res[0];
      if (!graph) return; // graph 数据是渲染前提，失败已 toast
      if (haveInsights && res[2]) {
        // SSE 刷新：洞察数据并回主请求保持新鲜
        state.insightsData = {
          orphans: res[2].orphans || [],
          broken: (res[3] && res[3].broken) || [],
          orphanTotal: res[2].total || 0,
          brokenTotal: (res[3] && res[3].total) || 0,
        };
      }
      var orphanRows = [];
      if (haveInsights && res[2]) orphanRows = res[2].orphans || [];
      else if (state.insightsData) orphanRows = state.insightsData.orphans;
      var fingerprint =
        sel.join(',') + ':' + (graph.nodes || []).length + ':' + (graph.edges || []).length;
      var dataChanged = fingerprint !== state.fingerprint;
      state.fingerprint = fingerprint;
      state.data = { graph: graph, stats: res[1] || {} };
      hideIndexing();
      showTruncated(!!graph.truncated);
      renderInsights();
      updateReindexBtn();
      if (!dataChanged && state.model) {
        return; // 数据未变（重索引进度刷新）：保留布局，不重启物理引擎
      }
      // 修复前每次 reload 重置 view（用户缩放/平移每秒丢失一次）
      var firstLoad = !state.model;
      state.model = buildGraphModel(graph.nodes || [], graph.edges || [], orphanRows);
      if (firstLoad) state.view = { x: 0, y: 0, scale: 1 };
      toggleEmptyState(!state.model.nodes.length);
      // 布局降级决策：大图（>FORCE_AUTO_MAX_NODES）先网格快速布局立即可
      // 交互（pan/zoom/hitTest 只依赖 x/y），力导向改为手动按钮按需启用
      if (shouldAutoForce(state.model.nodes.length)) {
        state.layoutMode = 'force';
        startSimulation();
      } else {
        state.layoutMode = 'grid';
        var w = getCanvas().clientWidth || 800;
        var h = getCanvas().clientHeight || 600;
        gridLayout(state.model, w, h);
        draw();
        showForceHint(state.model.nodes.length);
      }
      scheduleInsightsLoad();
    });
  }

  // ── 洞察数据懒加载（非关键路径：空闲时后台加载，首帧不等待）──
  function loadInsightsData(opts) {
    if (state.insightsController) state.insightsController.abort();
    var ctrl = (state.insightsController = new AbortController());
    var seq = ++state.insightsSeq;
    var sel = state.selection.length ? state.selection : state.projects.map(function (p) {
      return p.id;
    });
    if (!sel.length) return;
    var q = 'projects=' + sel.join(',');
    var o = { signal: ctrl.signal };
    var orphansP = fetchJ('/api/graph/orphans?' + q + '&limit=10000', o).catch(function (err) {
      // 用户主动打开面板失败才 toast；后台静默失败（防御式，降级仅影响淡化）
      if (!ctrl.signal.aborted && opts && opts.userInitiated) {
        window.toast && window.toast(String((err && err.message) || err), 'error');
      }
      return null;
    });
    var brokenP = fetchJ('/api/graph/broken?' + q + '&limit=500', o).catch(function () {
      return null;
    });
    Promise.all([orphansP, brokenP]).then(function (res) {
      if (ctrl.signal.aborted || seq !== state.insightsSeq) return; // 过期响应丢弃
      var orphans = res[0] || {};
      var broken = res[1] || {};
      state.insightsData = {
        orphans: orphans.orphans || [],
        broken: broken.broken || [],
        orphanTotal: orphans.total || 0,
        brokenTotal: broken.total || 0,
      };
      if (state.model) {
        applyOrphans(state.model, state.insightsData.orphans);
        scheduleDraw(); // 淡化立即生效
      }
      renderInsights();
    });
  }

  function scheduleInsightsLoad() {
    if (state.insightsData) return;
    if (window.requestIdleCallback) {
      window.requestIdleCallback(function () {
        loadInsightsData();
      });
    } else {
      setTimeout(function () {
        loadInsightsData();
      }, 300);
    }
  }

  // ── 力导向模拟（d3-force，rAF 合并绘制）──
  /** 无物理引擎降级：网格铺开（静态布局，不白屏） */
  function gridLayout(model, w, h) {
    var n = model.nodes.length;
    if (!n) return;
    var cols = Math.max(1, Math.ceil(Math.sqrt((n * w) / h)));
    var rows = Math.ceil(n / cols);
    var cw = w / cols;
    var ch = h / rows;
    for (var i = 0; i < n; i++) {
      var node = model.nodes[i];
      node.x = cw * (i % cols) + cw / 2;
      node.y = ch * Math.floor(i / cols) + ch / 2;
    }
  }

  function startSimulation() {
    // 修复前：'end' 后 state.sim=null → 拖拽只设 fx/fy 不重启物理 → 拖拽永久失效。
    // 现在保留已收敛的 sim 引用（无 tick 无成本），拖拽时 lazy restart。
    if (state.sim && state.sim._doc77Active) state.sim.stop();
    var model = state.model;
    if (!model || !model.nodes.length) return;
    var gen = ++state.simGen;
    loadD3Force(function () {
      if (gen !== state.simGen || !state.model) return; // 过期回调丢弃（双 sim 竞态）
      if (state.sim && state.sim._doc77Active) state.sim.stop();
      if (!window.d3 || !window.d3.forceSimulation) {
        var fw = getCanvas().clientWidth || 800;
        var fh = getCanvas().clientHeight || 600;
        gridLayout(state.model, fw, fh);
        state.layoutMode = 'grid';
        draw();
        return;
      }
      var w = getCanvas().clientWidth || 800;
      var h = getCanvas().clientHeight || 600;
      // 大图物理自适应（physicsFor 分段）：加速收敛、大图去 collide/弱电荷
      var phys = physicsFor(model.nodes.length);
      var sim = window.d3
        .forceSimulation(model.nodes)
        .force(
          'link',
          window.d3.forceLink(model.edges).id(function (d) {
            return d.id;
          }).distance(phys.linkDistance),
        )
        .force('charge', window.d3.forceManyBody().strength(phys.chargeStrength).distanceMax(phys.chargeDistanceMax))
        .force('center', window.d3.forceCenter(w / 2, h / 2))
        .force(
          'x',
          window.d3.forceX(w / 2).strength(phys.centerStrength),
        )
        .force(
          'y',
          window.d3.forceY(h / 2).strength(phys.centerStrength),
        );
      if (phys.collide) {
        sim.force(
          'collide',
          window.d3.forceCollide().radius(function (d) {
            return d.radius + 1;
          }),
        );
      }
      sim.alphaDecay(phys.alphaDecay).velocityDecay(phys.velocityDecay).on('tick', scheduleDraw);
      sim._doc77Active = true;
      state.sim = sim;
      state.layoutMode = 'force';
      hideForceHint();
      sim.on('end', function () {
        sim._doc77Active = false; // 收敛后停摆但保留引用：拖拽时 lazy restart
      });
    });
  }

  /** 手动启用力导向（大图降级后按钮）：节点已有 grid x/y 作初始位置，平滑过渡 */
  function enableForceLayout() {
    hideForceHint();
    state.layoutMode = 'force';
    startSimulation();
  }

  /** 大图降级横幅（仅 d3 可用时显示——按钮点不动就没意义） */
  function showForceHint(n) {
    var hint = document.getElementById('forceHint');
    if (!hint) return;
    if (!window.d3 || !window.d3.forceSimulation) return;
    var label = hint.querySelector('[data-i18n="web.graph.layoutHint"]');
    if (label) label.textContent = t('web.graph.layoutHint', { n: String(n) });
    hint.classList.remove('hidden');
  }

  function hideForceHint() {
    var hint = document.getElementById('forceHint');
    if (hint) hint.classList.add('hidden');
  }

  function scheduleDraw() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(function () {
      state.raf = null;
      draw();
    });
  }

  // ── 渲染 ──
  function draw() {
    var canvas = getCanvas();
    if (!canvas || !state.model) return;
    var ctx = canvas.getContext('2d');
    var dpr = canvas._dpr || 1;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    var view = state.view;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);

    var edgeColor = state.dark ? 'rgba(148,163,184,0.35)' : 'rgba(100,116,139,0.35)';
    var labelColor = state.dark ? '#cbd5e1' : '#475569';

    // 边（单 pass；降级模式（无 d3）source/target 是字符串 id，按 byId 解析——
    // 修复前 moveTo(NaN) 导致降级时一条边都画不出来）
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1 / view.scale; // 屏幕恒定 1px
    ctx.beginPath();
    var edges = state.model.edges;
    var byId = {};
    var nodes = state.model.nodes;
    for (var ni = 0; ni < nodes.length; ni++) byId[nodes[ni].id] = nodes[ni];
    // 边视口裁剪（修复前每帧画全部边：200k 边时平移/缩放掉帧）。
    // margin 用世界单位 64，覆盖半径上限 16 + 标签余量 + 线宽容差
    var worldRect = worldRectForView(view, w, h, 64);
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var s = typeof e.source === 'string' ? byId[e.source] : e.source;
      var t = typeof e.target === 'string' ? byId[e.target] : e.target;
      if (!s || !t || typeof s.x !== 'number' || typeof t.x !== 'number') continue;
      if (!edgePotentiallyVisible({ x1: s.x, y1: s.y, x2: t.x, y2: t.y }, worldRect)) continue;
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
    }
    ctx.stroke();

    // 节点（视口裁剪）
    var labelCount = 0;
    var showLabels = view.scale >= LABEL_MIN_SCALE;
    // 字体随缩放换算（修复前世界坐标空间下 scale=8 时 88px 大字重叠）
    ctx.font = 11 / view.scale + 'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      var sx = view.x + n.x * view.scale;
      var sy = view.y + n.y * view.scale;
      if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue; // 裁剪
      var alpha = n.isOrphan && state.dimOrphans ? 0.18 : 0.92;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colorForTag(n.tags && n.tags[0]);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fill();
      // hover / 高亮描边
      if (n.id === state.hover || n.id === state.highlightId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2 / view.scale;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (showLabels && labelCount < LABEL_MAX_COUNT) {
        ctx.globalAlpha = Math.max(alpha, 0.85);
        ctx.fillStyle = labelColor;
        ctx.fillText(n.title.length > 24 ? n.title.slice(0, 23) + '…' : n.title, n.x, n.y - n.radius - 3);
        labelCount++;
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── 交互：滚轮缩放 / 拖拽平移 / 拖节点 / 点击打开 ──
  function canvasCoords(e) {
    var rect = getCanvas().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function bindCanvasEvents() {
    var canvas = getCanvas();
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var c = canvasCoords(e);
      var factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(state.view, c.x, c.y, factor);
      clampView(state.view, canvas.clientWidth, canvas.clientHeight);
      scheduleDraw();
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return; // 仅左键（修复前右键点击节点误触发 openDoc）
      var c = canvasCoords(e);
      var id = hitTest(state.view, c.x, c.y, state.model ? state.model.nodes : []);
      state.dragged = false;
      if (id) {
        var node = null;
        for (var i = 0; i < state.model.nodes.length; i++) {
          if (state.model.nodes[i].id === id) {
            node = state.model.nodes[i];
            break;
          }
        }
        state.dragNode = node;
        // 修复前 sim 收敛（'end'）后 state.sim 被置 null → 拖拽永久失效；
        // 现在 sim 保留引用，restart() 即可重新激活物理
        if (state.sim) {
          node.fx = node.x;
          node.fy = node.y;
          state.sim.alphaTarget(0.3).restart();
        }
        // grid 模式（无 sim）：不设 fx/fy（无消费者），拖拽走 x/y 直写分支
      } else {
        state.panning = true;
        state.panStart = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
      }
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', function (e) {
      var c = canvasCoords(e);
      if (state.dragNode) {
        var dx = (c.x - state.view.x) / state.view.scale;
        var dy = (c.y - state.view.y) / state.view.scale;
        if (state.sim) {
          state.dragNode.fx = dx;
          state.dragNode.fy = dy;
          state.sim.alphaTarget(0.3).restart();
        } else {
          // grid 模式：直写 x/y（修复前只设 fx/fy，无 sim 时节点拖不动）
          state.dragNode.x = dx;
          state.dragNode.y = dy;
        }
        state.dragged = true;
        scheduleDraw();
        return;
      }
      if (state.panning && state.panStart) {
        state.view.x = state.panStart.vx + (e.clientX - state.panStart.x);
        state.view.y = state.panStart.vy + (e.clientY - state.panStart.y);
        state.dragged = true;
        scheduleDraw();
        return;
      }
      var id = hitTest(state.view, c.x, c.y, state.model ? state.model.nodes : []);
      var hoverChanged = id !== state.hover;
      state.hover = id;
      getCanvas().style.cursor = id ? 'pointer' : 'default';
      showTooltip(id, c.x, c.y);
      if (hoverChanged || state.highlightId) scheduleDraw(); // hover 未变跳过重绘
    });

    canvas.addEventListener('pointerup', function (e) {
      if (e.button !== 0) return;
      if (state.dragNode) {
        // grid 模式未设 fx/fy，无需清理（避免污染后续力导向会话）
        if (state.sim) {
          state.dragNode.fx = null;
          state.dragNode.fy = null;
          state.sim.alphaTarget(0);
        }
        if (!state.dragged) openDoc(state.dragNode.pid, state.dragNode.path); // 点击（未拖动）
        state.dragNode = null;
      }
      state.panning = false;
      state.panStart = null;
    });

    // 修复前无 pointercancel：指针捕获丢失（窗口外释放/触摸取消）后
    // dragNode/panning 永久卡住，后续每次 move 都拖拽节点
    canvas.addEventListener('pointercancel', function () {
      if (state.dragNode) {
        if (state.sim) {
          state.dragNode.fx = null;
          state.dragNode.fy = null;
          state.sim.alphaTarget(0);
        }
        state.dragNode = null;
      }
      state.panning = false;
      state.panStart = null;
    });

    canvas.addEventListener('pointerleave', function () {
      state.hover = null;
      hideTooltip();
      scheduleDraw();
    });
  }

  function findNodeById(id) {
    if (!id || !state.model) return null;
    for (var i = 0; i < state.model.nodes.length; i++) {
      if (state.model.nodes[i].id === id) return state.model.nodes[i];
    }
    return null;
  }

  function showTooltip(id, x, y) {
    var tip = document.getElementById('graphTooltip');
    if (!tip) return;
    var node = findNodeById(id);
    if (!node) {
      tip.classList.add('hidden');
      return;
    }
    var tags = node.tags.length ? node.tags.join(', ') : '';
    tip.innerHTML =
      '<div class="font-medium">' +
      esc(node.title) +
      '</div><div class="text-slate-400 dark:text-slate-500 mt-0.5 break-all">' +
      esc(node.path) +
      '</div>' +
      (tags ? '<div class="text-blue-500 dark:text-blue-400 mt-0.5">' + esc(tags) + '</div>' : '') +
      (node.isOrphan
        ? '<div class="text-amber-500 mt-0.5">' + esc(t('web.graph.orphans')) + '</div>'
        : '');
    tip.classList.remove('hidden');
    var wrap = document.getElementById('graphWrap');
    var wr = wrap.getBoundingClientRect();
    var left = Math.min(x + 14, wr.width - tip.offsetWidth - 8);
    var top = Math.min(y + 14, wr.height - tip.offsetHeight - 8);
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip() {
    var tip = document.getElementById('graphTooltip');
    if (tip) tip.classList.add('hidden');
  }

  // ── 搜索定位节点（全局 FTS；结果限定在当前图谱节点集内）──
  function bindSearch() {
    var input = document.getElementById('nodeSearch');
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (!q) {
        hideSearchResults();
        return;
      }
      timer = setTimeout(function () {
        runSearch(q);
      }, 200);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideSearchResults();
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#nodeSearch') && !e.target.closest('#searchResults')) {
        hideSearchResults();
      }
    });
  }

  var searchSeq = 0; // 搜索竞态守卫：仅最后一次请求的结果可渲染

  function runSearch(q) {
    var seq = ++searchSeq;
    fetchJ('/api/fts?q=' + encodeURIComponent(q) + '&limit=10')
      .then(function (d) {
        if (seq !== searchSeq) return; // 过期响应（快速输入时旧请求后到）丢弃
        var hits = [];
        var groups = (d && d.groups) || [];
        for (var g = 0; g < groups.length; g++) {
          var grp = groups[g];
          if (state.selection.length && state.selection.indexOf(grp.project_id) < 0) continue;
          var results = grp.results || [];
          for (var r = 0; r < results.length; r++) {
            var id = String(grp.project_id) + ':' + results[r].file_path;
            if (state.model && state.model.nodes.some(function (n) { return n.id === id; })) {
              hits.push({
                id: id,
                title: results[r].title || results[r].file_path,
                path: results[r].file_path,
                project: grp.project_name || '',
              });
            }
          }
        }
        renderSearchResults(hits.slice(0, 10));
      })
      .catch(function () {
        if (seq === searchSeq) hideSearchResults();
      });
  }

  function renderSearchResults(hits) {
    var box = document.getElementById('searchResults');
    if (!hits.length) {
      box.innerHTML =
        '<div class="px-3 py-2 text-slate-400 dark:text-slate-500">' +
        esc(t('web.graph.noResults')) +
        '</div>';
      box.classList.remove('hidden');
      return;
    }
    var html = '';
    for (var i = 0; i < hits.length; i++) {
      html +=
        '<button data-hit="' +
        esc(hits[i].id) +
        '" class="w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 flex flex-col gap-0.5 border-b border-slate-100 dark:border-slate-700 last:border-0">' +
        '<span class="text-slate-700 dark:text-slate-200">' +
        esc(hits[i].title) +
        '</span>' +
        '<span class="text-xs text-slate-400 dark:text-slate-500 truncate">' +
        (hits[i].project ? esc(hits[i].project) + ' · ' : '') +
        esc(hits[i].path) +
        '</span></button>';
    }
    box.innerHTML = html;
    box.classList.remove('hidden');
    box.querySelectorAll('button[data-hit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-hit');
        hideSearchResults();
        focusNode(id);
      });
    });
  }

  function hideSearchResults() {
    var box = document.getElementById('searchResults');
    if (box) box.classList.add('hidden');
  }

  /** 缩放居中 + 2s 高亮 */
  function focusNode(id) {
    if (!state.model) return;
    var node = null;
    for (var i = 0; i < state.model.nodes.length; i++) {
      if (state.model.nodes[i].id === id) {
        node = state.model.nodes[i];
        break;
      }
    }
    if (!node) return;
    var canvas = getCanvas();
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    var scale = Math.max(state.view.scale, 1.5);
    state.view.scale = scale;
    state.view.x = w / 2 - node.x * scale;
    state.view.y = h / 2 - node.y * scale;
    // 修复前 focusNode 不 clamp：聚焦远离原点的节点后滚轮一次就被
    // clampView 拉回 ±2 视口边界，节点跳出视野
    clampView(state.view, w, h);
    state.highlightId = id;
    clearTimeout(state.highlightTimer);
    state.highlightTimer = setTimeout(function () {
      state.highlightId = null;
      scheduleDraw();
    }, 2000);
    scheduleDraw();
  }

  // ── 洞察面板（孤立页 / 死链）──
  function bindInsights() {
    document.getElementById('insightsBtn').addEventListener('click', function () {
      document.getElementById('insightsPanel').classList.remove('hidden');
      // 洞察数据懒加载：用户主动打开面板时立即拉取（保证内容新鲜）
      if (!state.insightsData) loadInsightsData({ userInitiated: true });
    });
    document.getElementById('insightsClose').addEventListener('click', function () {
      document.getElementById('insightsPanel').classList.add('hidden');
    });
    document.getElementById('tabOrphans').addEventListener('click', function () {
      setInsightsTab('orphans');
    });
    document.getElementById('tabBroken').addEventListener('click', function () {
      setInsightsTab('broken');
    });
    document.getElementById('insightBody').addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-open]');
      if (!btn) return;
      var v = btn.getAttribute('data-open'); // "<pid>:<path>"
      var sep = v.indexOf(':');
      openDoc(v.slice(0, sep), v.slice(sep + 1));
    });
  }

  function setInsightsTab(tab) {
    state.insightsTab = tab;
    state.insightPage = 1;
    var orphansBtn = document.getElementById('tabOrphans');
    var brokenBtn = document.getElementById('tabBroken');
    var active = 'insight-tab px-3 py-1.5 text-sm rounded-md bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300';
    var idle = 'insight-tab px-3 py-1.5 text-sm rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700';
    orphansBtn.className = tab === 'orphans' ? active : idle;
    brokenBtn.className = tab === 'broken' ? active : idle;
    renderInsights();
  }

  function renderInsights() {
    var body = document.getElementById('insightBody');
    if (!body || !state.data) return;
    // 数据懒加载未完成：显示加载占位（后台空闲加载，面板打开前已就绪）
    if (!state.insightsData) {
      body.innerHTML =
        '<div class="text-slate-400 dark:text-slate-500 py-8 text-center">' +
        esc(t('web.graph.loading')) +
        '</div>';
      return;
    }
    var isOrphans = state.insightsTab === 'orphans';
    state.insightRows = isOrphans ? state.insightsData.orphans : state.insightsData.broken;
    var total = isOrphans ? state.insightsData.orphanTotal : state.insightsData.brokenTotal;
    if (!total) {
      body.innerHTML =
        '<div class="text-slate-400 dark:text-slate-500 py-8 text-center">' +
        esc(t(isOrphans ? 'web.graph.noOrphans' : 'web.graph.noBroken')) +
        '</div>';
      return;
    }
    var rows = state.insightRows;
    var page = state.insightPage;
    var slice = rows.slice(0, page * INSIGHT_PAGE_SIZE);
    var html = '';
    for (var i = 0; i < slice.length; i++) {
      html += isOrphans ? orphanRow(slice[i]) : brokenRow(slice[i]);
    }
    // 孤儿 >10000 时 API 截断（limit=10000）：显示提示防与 stats 计数
    // 语义发散（修复前静默只显示前 10000，load-more 还消失）
    if (total > rows.length) {
      html +=
        '<div class="text-xs text-amber-500 dark:text-amber-400 py-1.5">' +
        esc(t('web.graph.orphanLimit', { n: String(rows.length) })) +
        '</div>';
    }
    var hasMore = rows.length > slice.length;
    html +=
      '<button id="insightLoadMore" class="' +
      (hasMore ? '' : 'hidden ') +
      'w-full mt-2 px-3 py-2 text-sm rounded-md border border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700">' +
      esc(t('web.graph.loadMore')) +
      ' (' +
      rows.length +
      ' / ' +
      total +
      ')</button>';
    body.innerHTML = html;
    var more = document.getElementById('insightLoadMore');
    if (more) {
      more.addEventListener('click', function () {
        state.insightPage += 1;
        renderInsights();
      });
    }
  }

  function orphanRow(row) {
    var label = row.title || row.path;
    return (
      '<button data-open="' +
      esc(row.project_id + ':' + row.path) +
      '" class="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 flex flex-col gap-0.5 border-b border-slate-100 dark:border-slate-700 last:border-0">' +
      '<span class="text-slate-700 dark:text-slate-200">' +
      esc(label) +
      '</span>' +
      '<span class="text-xs text-slate-400 dark:text-slate-500 truncate">' +
      (state.selection.length > 1 || state.selection.length === 0
        ? esc(projectName(row.project_id)) + ' · '
        : '') +
      esc(row.path) +
      '</span></button>'
    );
  }

  function brokenRow(row) {
    var target = row.display || row.to_path;
    return (
      '<button data-open="' +
      esc(row.project_id + ':' + row.from_path) +
      '" class="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 flex flex-col gap-0.5 border-b border-slate-100 dark:border-slate-700 last:border-0">' +
      '<span class="text-slate-700 dark:text-slate-200">' +
      esc(row.from_path.split('/').pop() || row.from_path) +
      '</span>' +
      '<span class="text-xs text-red-500 dark:text-red-400 truncate">' +
      esc('→ ' + target) +
      '</span>' +
      '<span class="text-xs text-slate-400 dark:text-slate-500">' +
      esc(t('web.graph.openSource')) +
      '</span></button>'
    );
  }

  // ── 控件 ──
  function bindControls() {
    document.getElementById('orphanDimToggle').addEventListener('change', function (e) {
      state.dimOrphans = e.target.checked;
      scheduleDraw();
    });
    document.getElementById('reindexBtn').addEventListener('click', function () {
      if (state.selection.length !== 1) return;
      fetch('/api/graph/' + state.selection[0] + '/index', { method: 'POST' }).catch(function () {});
      window.toast && window.toast(t('web.graph.indexing'), 'info');
    });
    document.getElementById('emptyReindexBtn').addEventListener('click', function () {
      if (state.selection.length !== 1) return;
      fetch('/api/graph/' + state.selection[0] + '/index', { method: 'POST' }).catch(function () {});
      window.toast && window.toast(t('web.graph.indexing'), 'info');
    });
    var forceEnableBtn = document.getElementById('forceEnableBtn');
    if (forceEnableBtn) {
      forceEnableBtn.addEventListener('click', enableForceLayout);
    }
  }

  function updateReindexBtn() {
    document.getElementById('reindexBtn').classList.toggle('hidden', state.selection.length !== 1);
  }

  function toggleEmptyState(empty) {
    document.getElementById('emptyState').classList.toggle('hidden', !empty);
    document.getElementById('emptyReindexBtn').classList.toggle('hidden', state.selection.length !== 1);
  }

  function showTruncated(on) {
    document.getElementById('truncatedNotice').classList.toggle('hidden', !on);
  }

  function showIndexing() {
    document.getElementById('indexingNotice').classList.remove('hidden');
  }

  function hideIndexing() {
    document.getElementById('indexingNotice').classList.add('hidden');
  }

  // ── SSE：索引进度 / 文件变更 → 1s 去抖重载 ──
  function initSSE() {
    if (!window.EventSource) return;
    // EventSource 无法设置 Authorization header；session token 经 ?token=
    // 传递（服务端仅对 /api/events 开放 query token；'1' 为无 token 哨兵）
    var tok = sessionStorage.getItem('doc77-auth');
    var es = new EventSource(
      '/api/events' + (tok && tok !== '1' ? '?token=' + encodeURIComponent(tok) : ''),
    );
    var scheduleReload = function () {
      clearTimeout(state.reloadTimer);
      state.reloadTimer = setTimeout(function () {
        showIndexing();
        loadData();
      }, 1000);
    };
    var inSelection = function (pid) {
      return (
        state.selection.length === 0 ||
        state.selection.indexOf(pid) >= 0 ||
        (state.data && (state.data.graph.projects || []).indexOf(pid) >= 0)
      );
    };
    es.addEventListener('graph:index-progress', function (ev) {
      var d = null;
      try {
        d = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (d && d.projectId && inSelection(d.projectId)) scheduleReload();
    });
    es.addEventListener('file-tree:changed', function (ev) {
      // 修复前无条件重载：其他项目（不在当前选择）的文件变更也触发
      // reload，重索引期间每 ~1s 重启一次 5000 节点物理引擎
      var d = null;
      try {
        d = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (d && d.projectId && inSelection(d.projectId)) scheduleReload();
    });
    // 修复前无 onerror：401（服务重启/token 过期）→ 每 ~3s 无限重连，
    // 永不恢复。连续失败 3 次 → 关闭并一次性提示。
    var sseFailures = 0;
    es.onopen = function () {
      sseFailures = 0;
    };
    es.onerror = function () {
      sseFailures++;
      if (sseFailures >= 3 && es.readyState === EventSource.CLOSED) {
        es.close();
        window.toast && window.toast(t('web.graph.sseLost'), 'error');
      }
    };
  }

  // ── 启动 ──
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  // Public API（纯函数核心供 vitest 测试）
  return {
    buildGraphModel: buildGraphModel,
    colorForTag: colorForTag,
    nodeRadius: nodeRadius,
    hitTest: hitTest,
    applyViewToCtx: applyViewToCtx,
    clampView: clampView,
    zoomAt: zoomAt,
    gridLayout: gridLayout,
    shouldAutoForce: shouldAutoForce,
    physicsFor: physicsFor,
    applyOrphans: applyOrphans,
    worldRectForView: worldRectForView,
    edgePotentiallyVisible: edgePotentiallyVisible,
    FORCE_AUTO_MAX_NODES: FORCE_AUTO_MAX_NODES,
    PALETTE: PALETTE,
    NEUTRAL: NEUTRAL,
  };
});
