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
      var r = (n.radius || 5) + 4; // 命中容差
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
  }

  // ── 页面状态 ──
  var state = {
    projects: [], // [{id, name}]
    selection: [], // number[]；[] = 全部
    data: null, // {graph, stats, orphans[], broken[], orphanTotal, brokenTotal}
    model: null, // buildGraphModel 输出
    view: { x: 0, y: 0, scale: 1 },
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
    reloadTimer: null,
    insightsTab: 'orphans',
    insightPage: 1,
    insightRows: [], // 当前 tab 的全部行（客户端分页）
  };

  function getCanvas() {
    return document.getElementById('graphCanvas');
  }

  function fetchJ(url) {
    return fetch(url).then(function (r) {
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

  // ── 数据加载（四请求并行，AbortController 取消过期请求）──
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
    Promise.all([
      fetchJ('/api/graph?' + q),
      fetchJ('/api/graph/stats?' + q),
      fetchJ('/api/graph/orphans?' + q + '&limit=10000'),
      fetchJ('/api/graph/broken?' + q + '&limit=500'),
    ])
      .then(function (res) {
        if (ctrl.signal.aborted) return;
        var graph = res[0];
        var orphans = res[2] || {};
        var broken = res[3] || {};
        state.data = {
          graph: graph,
          stats: res[1] || {},
          orphans: orphans.orphans || [],
          broken: broken.broken || [],
          orphanTotal: orphans.total || 0,
          brokenTotal: broken.total || 0,
        };
        state.model = buildGraphModel(graph.nodes || [], graph.edges || [], orphans.orphans || []);
        state.view = { x: 0, y: 0, scale: 1 };
        hideIndexing();
        showTruncated(!!graph.truncated);
        toggleEmptyState(!state.model.nodes.length);
        renderInsights();
        updateReindexBtn();
        startSimulation();
      })
      .catch(function (err) {
        if (!ctrl.signal.aborted) {
          window.toast && window.toast(String((err && err.message) || err), 'error');
        }
      });
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
    if (state.sim) state.sim.stop();
    state.sim = null;
    var model = state.model;
    if (!model || !model.nodes.length) return;
    loadD3Force(function () {
      if (!state.model) return;
      if (!window.d3 || !window.d3.forceSimulation) {
        var fw = getCanvas().clientWidth || 800;
        var fh = getCanvas().clientHeight || 600;
        gridLayout(state.model, fw, fh);
        draw();
        return;
      }
      var w = getCanvas().clientWidth || 800;
      var h = getCanvas().clientHeight || 600;
      var sim = window.d3
        .forceSimulation(model.nodes)
        .force(
          'link',
          window.d3.forceLink(model.edges).id(function (d) {
            return d.id;
          }).distance(PHYSICS.linkDistance),
        )
        .force('charge', window.d3.forceManyBody().strength(PHYSICS.chargeStrength).distanceMax(PHYSICS.chargeDistanceMax))
        .force('center', window.d3.forceCenter(w / 2, h / 2))
        .force(
          'x',
          window.d3.forceX(w / 2).strength(PHYSICS.centerStrength),
        )
        .force(
          'y',
          window.d3.forceY(h / 2).strength(PHYSICS.centerStrength),
        )
        .force(
          'collide',
          window.d3.forceCollide().radius(function (d) {
            return d.radius + 1;
          }),
        )
        .alphaDecay(PHYSICS.alphaDecay)
        .velocityDecay(PHYSICS.velocityDecay)
        .on('tick', scheduleDraw);
      state.sim = sim;
      sim.on('end', function () {
        if (state.sim === sim) state.sim = null; // 收敛后释放（alpha < ~0.0015 触发）
      });
    });
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

    // 边（单 pass）
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1 / view.scale; // 屏幕恒定 1px
    ctx.beginPath();
    var edges = state.model.edges;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var s = e.source;
      var t = e.target;
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
    }
    ctx.stroke();

    // 节点（视口裁剪）
    var nodes = state.model.nodes;
    var labelCount = 0;
    var showLabels = view.scale >= LABEL_MIN_SCALE;
    ctx.font = '11px system-ui, -apple-system, sans-serif';
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
        node.fx = node.x;
        node.fy = node.y;
        if (state.sim) state.sim.alphaTarget(0.3).restart();
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
        state.dragNode.fx = dx;
        state.dragNode.fy = dy;
        state.dragged = true;
        if (state.sim) state.sim.alphaTarget(0.3).restart();
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
      state.hover = id;
      getCanvas().style.cursor = id ? 'pointer' : 'default';
      showTooltip(id, c.x, c.y);
      scheduleDraw();
    });

    canvas.addEventListener('pointerup', function (e) {
      if (state.dragNode) {
        state.dragNode.fx = null;
        state.dragNode.fy = null;
        if (state.sim) state.sim.alphaTarget(0);
        if (!state.dragged) openDoc(state.dragNode.pid, state.dragNode.path); // 点击（未拖动）
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

  function showTooltip(id, x, y) {
    var tip = document.getElementById('graphTooltip');
    if (!tip) return;
    if (!id || !state.model) {
      tip.classList.add('hidden');
      return;
    }
    var node = null;
    for (var i = 0; i < state.model.nodes.length; i++) {
      if (state.model.nodes[i].id === id) {
        node = state.model.nodes[i];
        break;
      }
    }
    if (!node) return;
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

  function runSearch(q) {
    fetchJ('/api/fts?q=' + encodeURIComponent(q) + '&limit=10')
      .then(function (d) {
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
        hideSearchResults();
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
        escAttr(hits[i].id) +
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
    var isOrphans = state.insightsTab === 'orphans';
    state.insightRows = isOrphans ? state.data.orphans : state.data.broken;
    var total = isOrphans ? state.data.orphanTotal : state.data.brokenTotal;
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
      escAttr(row.project_id + ':' + row.path) +
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
      escAttr(row.project_id + ':' + row.from_path) +
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
    es.addEventListener('graph:index-progress', function (ev) {
      var d = null;
      try {
        d = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (d && d.projectId) {
        var inSel =
          state.selection.length === 0 ||
          state.selection.indexOf(d.projectId) >= 0 ||
          state.data &&
            (state.data.graph.projects || []).indexOf(d.projectId) >= 0;
        if (inSel) scheduleReload();
      }
    });
    es.addEventListener('file-tree:changed', scheduleReload);
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
    PALETTE: PALETTE,
    NEUTRAL: NEUTRAL,
  };
});
