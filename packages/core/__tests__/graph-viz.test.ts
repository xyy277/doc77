import { describe, it, expect } from 'vitest';
// @ts-expect-error - JS file without types
import GraphViz from '../src/web/js/graph.js';

const {
  buildGraphModel,
  colorForTag,
  nodeRadius,
  hitTest,
  applyViewToCtx,
  clampView,
  zoomAt,
  gridLayout,
  shouldAutoForce,
  physicsFor,
  applyOrphans,
  worldRectForView,
  edgePotentiallyVisible,
  FORCE_AUTO_MAX_NODES,
  NEUTRAL,
} = GraphViz as {
  buildGraphModel: (
    nodes: Array<{ project_id: number; path: string; title?: string; tags?: string[] }>,
    edges: Array<{ project_id: number; source: string; target: string }>,
    orphans?: Array<{ project_id: number; path: string }>,
  ) => {
    nodes: Array<{
      id: string;
      pid: number;
      path: string;
      title: string;
      tags: string[];
      inLinks: number;
      isOrphan: boolean;
      radius: number;
    }>;
    edges: Array<{ id: number; source: string; target: string; pid: number }>;
    maxInLinks: number;
    orphanCount: number;
  };
  colorForTag: (tag: string | undefined) => string;
  nodeRadius: (inLinks: number, maxInLinks: number) => number;
  hitTest: (
    view: { x: number; y: number; scale: number },
    x: number,
    y: number,
    nodes: Array<{ id: string; x: number; y: number; radius: number }>,
  ) => string | null;
  applyViewToCtx: (ctx: { setTransform: () => void }, view: unknown, dpr?: number) => void;
  clampView: (
    view: { x: number; y: number; scale: number },
    w: number,
    h: number,
  ) => { x: number; y: number; scale: number };
  zoomAt: (
    view: { x: number; y: number; scale: number },
    cx: number,
    cy: number,
    factor: number,
    minScale?: number,
    maxScale?: number,
  ) => { x: number; y: number; scale: number };
  gridLayout: (model: { nodes: Array<{ x?: number; y?: number }> }, w: number, h: number) => void;
  shouldAutoForce: (nodeCount: number, maxAutoNodes?: number) => boolean;
  physicsFor: (nodeCount: number) => {
    linkDistance: number;
    chargeStrength: number;
    chargeDistanceMax: number;
    centerStrength: number;
    alphaDecay: number;
    velocityDecay: number;
    collide: boolean;
  };
  applyOrphans: (
    model: {
      nodes: Array<{ id: string; isOrphan?: boolean }>;
      orphanCount?: number;
    },
    orphanRows?: Array<{ project_id: number; path: string }>,
  ) => number;
  worldRectForView: (
    view: { x: number; y: number; scale: number },
    w: number,
    h: number,
    margin?: number,
  ) => { x0: number; y0: number; x1: number; y1: number };
  edgePotentiallyVisible: (
    e: { x1: number; y1: number; x2: number; y2: number },
    rect: { x0: number; y0: number; x1: number; y1: number },
  ) => boolean;
  FORCE_AUTO_MAX_NODES: number;
  NEUTRAL: string;
};

/**
 * 跨项目同路径碰撞 fixture：
 * - p1: a→b, c→b, a→c（b 入链 2、c 入链 1）、d 无链接（孤儿）
 * - p2: x→a（2:a 入链 1）；x→c 目标不存在 → 边被过滤
 */
const NODES = [
  { project_id: 1, path: 'a.md', title: 'A', tags: ['tech', 'graph'] },
  { project_id: 1, path: 'b.md', title: 'B', tags: [] },
  { project_id: 1, path: 'c.md', title: 'C', tags: [] },
  { project_id: 1, path: 'd.md', title: 'D', tags: [] },
  { project_id: 2, path: 'a.md', title: 'A2', tags: ['notes'] },
  { project_id: 2, path: 'x.md', title: 'X', tags: [] },
];
const EDGES = [
  { project_id: 1, source: 'a.md', target: 'b.md' },
  { project_id: 1, source: 'c.md', target: 'b.md' },
  { project_id: 1, source: 'a.md', target: 'c.md' },
  { project_id: 2, source: 'x.md', target: 'a.md' },
  { project_id: 2, source: 'x.md', target: 'c.md' }, // 2:c.md 不存在 → 丢弃
];

describe('buildGraphModel', () => {
  it('id = "<project_id>:<path>"，跨项目路径碰撞不冲突', () => {
    const model = buildGraphModel(NODES, EDGES, [{ project_id: 1, path: 'd.md' }]);
    expect(model.nodes).toHaveLength(6);
    expect(model.nodes.map((n) => n.id).sort()).toEqual([
      '1:a.md',
      '1:b.md',
      '1:c.md',
      '1:d.md',
      '2:a.md',
      '2:x.md',
    ]);
    const a1 = model.nodes.find((n) => n.id === '1:a.md')!;
    const a2 = model.nodes.find((n) => n.id === '2:a.md')!;
    expect(a1.title).toBe('A');
    expect(a2.title).toBe('A2'); // 同名路径不同项目是不同节点
  });

  it('inLinks 按 target 精确计数，跨项目隔离', () => {
    const model = buildGraphModel(NODES, EDGES, []);
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.get('1:b.md')!.inLinks).toBe(2);
    expect(byId.get('1:c.md')!.inLinks).toBe(1);
    expect(byId.get('2:a.md')!.inLinks).toBe(1); // p2 的入链不泄漏到 p1
    expect(byId.get('1:d.md')!.inLinks).toBe(0);
    expect(model.maxInLinks).toBe(2);
  });

  it('孤儿集合与 API 列表一致；两端缺失的边被过滤', () => {
    const model = buildGraphModel(NODES, EDGES, [{ project_id: 1, path: 'd.md' }]);
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.get('1:d.md')!.isOrphan).toBe(true);
    expect(byId.get('1:b.md')!.isOrphan).toBe(false);
    expect(model.orphanCount).toBe(1);
    // x→c（目标不存在）与跨项目边均不进入边集
    expect(model.edges).toHaveLength(4);
    expect(model.edges.every((e) => e.pid === 1 || e.pid === 2)).toBe(true);
  });

  it('无标签节点 title 回退到文件名', () => {
    const model = buildGraphModel([{ project_id: 1, path: 'notes/hello.md' }], [], []);
    expect(model.nodes[0].title).toBe('hello.md');
  });
});

describe('nodeRadius', () => {
  it('随入链数单调递增，clamp [3,16]', () => {
    expect(nodeRadius(0, 2)).toBe(3);
    expect(nodeRadius(2, 2)).toBe(11);
    expect(nodeRadius(1, 2)).toBeGreaterThan(3);
    expect(nodeRadius(1, 2)).toBeLessThan(11);
    expect(nodeRadius(1000, 1)).toBe(16); // clamp 上限
    expect(nodeRadius(5, 5)).toBe(11);
  });

  it('maxInLinks=0 时全部为最小半径（不产生 NaN）', () => {
    expect(nodeRadius(0, 0)).toBe(3);
    expect(nodeRadius(7, 0)).toBe(3);
  });
});

describe('colorForTag', () => {
  it('确定性：同一标签永远同色', () => {
    expect(colorForTag('tech')).toBe(colorForTag('tech'));
    expect(colorForTag('graph')).toBe(colorForTag('graph'));
  });

  it('5 个不同标签至少 2 种颜色（调色板有区分度）', () => {
    const colors = new Set(['tech', 'notes', 'math', 'ai', 'todo'].map(colorForTag));
    expect(colors.size).toBeGreaterThanOrEqual(2);
  });

  it('无标签 → 中性色', () => {
    expect(colorForTag('')).toBe(NEUTRAL);
    expect(colorForTag(undefined as unknown as string)).toBe(NEUTRAL);
  });
});

describe('hitTest', () => {
  const nodes = [
    { id: 'n1', x: 100, y: 100, radius: 10 },
    { id: 'n2', x: 200, y: 200, radius: 6 },
  ];

  it('恒等视图：命中与未命中', () => {
    const view = { x: 0, y: 0, scale: 1 };
    expect(hitTest(view, 105, 100, nodes)).toBe('n1');
    expect(hitTest(view, 198, 198, nodes)).toBe('n2');
    expect(hitTest(view, 300, 300, nodes)).toBeNull();
  });

  it('平移视图：屏幕坐标 = view + 世界坐标', () => {
    const view = { x: 50, y: 20, scale: 1 };
    expect(hitTest(view, 150, 120, nodes)).toBe('n1'); // 100+50, 100+20
  });

  it('缩放视图：screen = view + world*scale', () => {
    const view = { x: 0, y: 0, scale: 2 };
    expect(hitTest(view, 200, 200, nodes)).toBe('n1');
  });

  it('重叠节点：最上层（后绘制）优先', () => {
    const overlap = [
      { id: 'bottom', x: 100, y: 100, radius: 10 },
      { id: 'top', x: 100, y: 100, radius: 4 },
    ];
    expect(hitTest({ x: 0, y: 0, scale: 1 }, 100, 100, overlap)).toBe('top');
  });

  it('命中容差随缩放换算：放大后边缘可点中，缩小时不产生幽灵命中区', () => {
    const node = [{ id: 'n1', x: 100, y: 100, radius: 10 }];
    // scale=2：节点屏幕位置 (200,200)，r=(10+4)*2=28 → 距中心 25px 命中
    // （修复前世界单位半径 14，25px 处不命中）
    expect(hitTest({ x: 0, y: 0, scale: 2 }, 200, 225, node)).toBe('n1');
    // scale=0.1：节点屏幕位置 (10,10)，r=1.4 → 屏幕距中心 10px 不命中
    // （修复前 14px 幽灵命中区）
    expect(hitTest({ x: 0, y: 0, scale: 0.1 }, 20, 10, node)).toBeNull();
  });
});

describe('view transforms', () => {
  it('zoomAt：锚点世界坐标往返不变', () => {
    const view = { x: 0, y: 0, scale: 1 };
    zoomAt(view, 50, 50, 2);
    expect(view.scale).toBe(2);
    expect(view.x).toBe(-50);
    expect(view.y).toBe(-50);
    // 世界点 (50,50) 在缩放前后都对应屏幕 (50,50)：
    // 前：(50-0)/1；后：(50-(-50))/2
    zoomAt(view, 50, 50, 0.5);
    expect(view.scale).toBe(1);
    expect(view.x).toBeCloseTo(0);
    expect(view.y).toBeCloseTo(0);
  });

  it('zoomAt：scale 被 clamp', () => {
    const view = { x: 0, y: 0, scale: 1 };
    zoomAt(view, 0, 0, 100);
    expect(view.scale).toBe(8);
    zoomAt(view, 0, 0, 0.0001);
    expect(view.scale).toBe(0.05);
  });

  it('zoomAt：factor=0 / Infinity 不产生 NaN', () => {
    const view = { x: 0, y: 0, scale: 1 };
    zoomAt(view, 10, 10, 0);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(Number.isFinite(view.x)).toBe(true);
    zoomAt(view, 10, 10, Infinity);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(Number.isFinite(view.x)).toBe(true);
  });

  it('clampView：w=0/h=0 不抛错且值有限', () => {
    const view = { x: 50, y: -50, scale: 3 };
    const out = clampView(view, 0, 0);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
    expect(out.scale).toBe(3);
  });

  it('clampView：平移与缩放边界', () => {
    const view = { x: 100000, y: -100000, scale: 99 };
    const out = clampView(view, 800, 600);
    expect(out.x).toBe(1600); // ±2w
    expect(out.y).toBe(-1200); // ±2h
    expect(out.scale).toBe(8);
  });

  it('applyViewToCtx：应用 DPR + 平移 + 缩放', () => {
    const calls: Array<[number, number, number, number, number, number]> = [];
    const ctx = {
      setTransform: (...args: [number, number, number, number, number, number]) => calls.push(args),
      translate: () => {},
      scale: () => {},
    } as {
      setTransform: (...args: [number, number, number, number, number, number]) => void;
      translate: () => void;
      scale: () => void;
    };
    applyViewToCtx(ctx, { x: 10, y: 20, scale: 2 }, 1.5);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([1.5, 0, 0, 1.5, 0, 0]); // DPR
  });
});

describe('shouldAutoForce（大图降级决策）', () => {
  it('边界：≤2000 自动力导向，>2000 降级', () => {
    expect(shouldAutoForce(FORCE_AUTO_MAX_NODES - 1)).toBe(true);
    expect(shouldAutoForce(FORCE_AUTO_MAX_NODES)).toBe(true);
    expect(shouldAutoForce(FORCE_AUTO_MAX_NODES + 1)).toBe(false);
  });

  it('空/异常输入不误降级', () => {
    expect(shouldAutoForce(0)).toBe(true);
    expect(shouldAutoForce(-5)).toBe(true);
  });

  it('自定义阈值生效', () => {
    expect(shouldAutoForce(10, 10)).toBe(true);
    expect(shouldAutoForce(11, 10)).toBe(false);
    expect(shouldAutoForce(9, 10)).toBe(true);
  });
});

describe('physicsFor（大图物理自适应）', () => {
  it('小图（≤1000）用基线参数（含 collide）', () => {
    for (const n of [1, 100, 1000]) {
      const p = physicsFor(n);
      expect(p.collide).toBe(true);
      expect(p.alphaDecay).toBe(0.045);
      expect(p.chargeStrength).toBe(-150);
    }
  });

  it('中图（1000<n≤2000）加速：去 collide、decay 提高', () => {
    for (const n of [1001, 1500, 2000]) {
      const p = physicsFor(n);
      expect(p.collide).toBe(false);
      expect(p.alphaDecay).toBeGreaterThanOrEqual(0.07);
      expect(p.chargeStrength).toBe(-100);
    }
  });

  it('大图（>2000）更强衰减 + 弱电荷', () => {
    for (const n of [2001, 5000, 100000]) {
      const p = physicsFor(n);
      expect(p.collide).toBe(false);
      expect(p.alphaDecay).toBeGreaterThanOrEqual(0.08);
      expect(p.chargeStrength).toBe(-80);
      expect(p.velocityDecay).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('衰减单调不减、电荷强度单调不增（数值上 charge 递增 = 强度递减）', () => {
    const decays = [1, 500, 1000, 1001, 2000, 2001, 10000].map((n) => physicsFor(n).alphaDecay);
    const charges = [1, 500, 1000, 1001, 2000, 2001, 10000].map(
      (n) => physicsFor(n).chargeStrength,
    );
    for (let i = 1; i < decays.length; i++) {
      expect(decays[i]).toBeGreaterThanOrEqual(decays[i - 1]);
      expect(charges[i]).toBeGreaterThanOrEqual(charges[i - 1]); // -150 → -100 → -80
    }
  });
});

describe('gridLayout（大图快速布局）', () => {
  it('空模型 no-op 不抛错', () => {
    expect(() => gridLayout({ nodes: [] }, 800, 600)).not.toThrow();
  });

  it('单节点落位（cols 由宽高比决定：sqrt(800/600)=1.15 → 2 列）', () => {
    const model = { nodes: [{ x: undefined, y: undefined }] };
    gridLayout(model, 800, 600);
    expect(model.nodes[0].x).toBe(200);
    expect(model.nodes[0].y).toBe(300);
  });

  it('全部节点落在画布内且坐标有限', () => {
    const nodes = Array.from({ length: 37 }, () => ({ x: undefined, y: undefined }));
    gridLayout({ nodes }, 800, 600);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.x!).toBeGreaterThanOrEqual(0);
      expect(n.x!).toBeLessThanOrEqual(800);
      expect(n.y!).toBeGreaterThanOrEqual(0);
      expect(n.y!).toBeLessThanOrEqual(600);
    }
  });
});

describe('applyOrphans（懒加载后就地应用）', () => {
  const rows = [
    { project_id: 1, path: 'a.md' },
    { project_id: 2, path: 'x.md' },
  ];

  it('正确标记孤儿并返回计数', () => {
    const model = buildGraphModel(NODES, EDGES, []);
    const count = applyOrphans(model, rows);
    expect(count).toBe(2);
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.get('1:a.md')!.isOrphan).toBe(true);
    expect(byId.get('2:x.md')!.isOrphan).toBe(true);
    expect(byId.get('1:b.md')!.isOrphan).toBe(false);
    expect(model.orphanCount).toBe(2);
  });

  it('只改属性不重建节点对象（保住 x/y/fx/fy）', () => {
    const model = buildGraphModel(NODES, EDGES, []);
    model.nodes.forEach((n, i) => {
      n.x = i * 10;
      n.y = i * 20;
    });
    const refs = model.nodes.map((n) => n);
    applyOrphans(model, rows);
    expect(model.nodes.map((n, i) => n === refs[i])).toEqual(model.nodes.map(() => true));
    expect(model.nodes[0].x).toBe(0);
    expect(model.nodes[0].y).toBe(0);
  });

  it('幂等：连调两次计数一致', () => {
    const model = buildGraphModel(NODES, EDGES, []);
    expect(applyOrphans(model, rows)).toBe(2);
    expect(applyOrphans(model, rows)).toBe(2);
  });

  it('空 rows 全置 false；null model 返回 0', () => {
    const model = buildGraphModel(NODES, EDGES, [{ project_id: 1, path: 'd.md' }]);
    expect(applyOrphans(model, [])).toBe(0);
    expect(model.nodes.every((n) => !n.isOrphan)).toBe(true);
    expect(applyOrphans(null as unknown as typeof model, rows)).toBe(0);
  });
});

describe('worldRectForView + edgePotentiallyVisible（边裁剪）', () => {
  it('世界矩形换算：屏幕原点 ↔ 世界坐标', () => {
    const rect = worldRectForView({ x: 100, y: 50, scale: 2 }, 800, 600, 0);
    // 屏幕 (0,0) → 世界 (0-100)/2 = -50；屏幕 (800,600) → (700/2, 550/2)
    expect(rect).toEqual({ x0: -50, y0: -25, x1: 350, y1: 275 });
  });

  it('margin 以世界单位外扩', () => {
    const rect = worldRectForView({ x: 0, y: 0, scale: 1 }, 800, 600, 64);
    expect(rect.x0).toBe(-64);
    expect(rect.y0).toBe(-64);
    expect(rect.x1).toBe(864);
    expect(rect.y1).toBe(664);
  });

  it('两端都在矩形外 → 不可见', () => {
    const rect = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(edgePotentiallyVisible({ x1: -10, y1: -10, x2: 50, y2: 200 }, rect)).toBe(false);
    expect(edgePotentiallyVisible({ x1: 200, y1: 200, x2: -50, y2: 150 }, rect)).toBe(false);
  });

  it('任一端在矩形内 → 可见；边界上可见', () => {
    const rect = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(edgePotentiallyVisible({ x1: 50, y1: 50, x2: 500, y2: 500 }, rect)).toBe(true);
    expect(edgePotentiallyVisible({ x1: 0, y1: 0, x2: -100, y2: -100 }, rect)).toBe(true); // 边界
  });
});
