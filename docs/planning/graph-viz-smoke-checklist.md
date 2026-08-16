# 图谱二阶段 + SSE 修复 — 手工冒烟清单（用户环境执行）

> 独立验证 Phase 6。环境：服务运行于 `<host>:27777`（LAN + 密码）。
> 前置：`pnpm dev:restart` 重启服务（含最新修复）；硬刷新（Ctrl+Shift+R）避免 SW 缓存旧 JS。
> 性能大项目：`node scripts/synth-graph-project.mjs ~/doc77-graph-perf-5000 5000` 生成，设置页注册后等启动 bootstrap 或点图谱页"重建索引"。

## 验收标准逐项

### ① 加载预算（5000 节点项目）
- [ ] DevTools → Performance 点 Record → 打开 `/graph?projects=<GraphPerf5000 的 id>`
- [ ] 首帧 canvas 像素出现 < 2s（DOMContentLoaded + 物理收敛）
- [ ] Network 面板：`/api/graph?projects=` 响应 < 1s，JSON 大小 1-2MB
- 测量法：Performance 面板 Load 事件 + Network 列

### ② 交互帧率（5000 节点）
- [ ] 拖拽平移 + 滚轮缩放 10s：无明显掉帧（≥50fps，目标 60）
- [ ] d3 约 3s 内收敛：之后 CPU 空闲（Performance 面板无持续高占用）
- 测量法：Performance → 渲染帧统计；CPU 时间线

### ③ 内存（5000 节点）
- [ ] 加载后 + 交互 30s 后各拍一次 Memory 快照：JS heap < 200MB（预期 20-60MB）
- [ ] 连续切换 3 个项目 tab：heap 无持续增长（每次回落）
- 测量法：DevTools → Memory → Heap snapshot

### ④ 孤儿淡化开关
- [ ] 孤儿节点（doc4999）半透明（alpha 0.18），链接节点全亮
- [ ] 关闭"淡化孤立页"开关 → 全部恢复全亮；再开 → 恢复淡化
- [ ] 淡化计数与 `/api/graph/orphans?projects=<id>` 的 total 一致（1 个）

### ⑤ 洞察面板一致性
- [ ] 打开洞察 → 孤立页列表含 doc4999；死链列表含 10 条 `missing-target-*`（5000 项目）
- [ ] 列表计数与 `/api/graph/stats?projects=<id>` 的 broken/orphans 完全一致
- [ ] 点断链行 → 打开**源文档**（preview 编辑模式）
- [ ] 点孤儿行 → 打开孤儿文档
- 测量法：对照 Network 里 stats 响应

### ⑥ 多项目聚合
- [ ] `/graph?projects=1,2`（两个真实项目）：节点/边聚合渲染，tooltip 显示项目名前缀
- [ ] 单项目 tab → "重建索引"按钮出现；"全部" tab → 按钮隐藏
- [ ] 点"重建索引" → toast"索引构建中" → 完成后图谱自动刷新（SSE 驱动）

### ⑦ 搜索定位
- [ ] 搜索框输入 `Doc 2500` → 下拉出现匹配 → 点击 → 缩放居中 + 琥珀色高亮 2s
- [ ] Esc 关闭下拉；无结果时显示"未找到匹配文档"

### ⑧ 点击跳转
- [ ] 左键点击节点（不拖动）→ 打开 `/preview.html?id=<pid>&path=...` 文档
- [ ] 右键点击节点 → 不跳转（上下文菜单正常）

### ⑨ SSE 认证（本次修复的核心验证）
- [ ] DevTools Network：`/api/events?token=<64位hex>` → **200** `text/event-stream`，无 401
- [ ] 外部改一个链接文件（或重建索引）→ 图谱页 1s 内自动刷新
- [ ] 服务重启后页面保持打开：观察是否出现"实时推送连接失败"toast（预期：连续 3 次失败后提示，不再无限重连）
- [ ] 隧道场景（若启用）：隧道 running + 非本机访问 → `/api/events?token=` 仍 200

### ⑩ 截断提示（可选，n=25000 大项目）
- [ ] `node scripts/synth-graph-project.mjs ~/doc77-graph-perf-25000 25000` 注册后：橙色"图谱数据过大，仅显示部分"提示出现
- [ ] stats 计数仍正确（列表/计数不受截断影响）

## 回归抽查（一阶段面板不受影响）
- [ ] preview 页：反向链接面板、相关文档推荐正常显示
- [ ] 保存带 wikilink 的文件 → 面板刷新；死链标灰

## 已知限制（非缺陷，设计记录）
- SSE 流仅在连接时鉴权：注销/改密后已打开的流继续投递至连接关闭（新连接 401）
- 孤儿 >10000 时洞察面板显示"仅显示前 N 条"提示（计数仍准确）
- access_policy 'password' 配置项当前未强制（仅 readonly 生效）
