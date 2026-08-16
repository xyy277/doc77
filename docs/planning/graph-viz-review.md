# 图谱二阶段 + SSE 修复 — 独立对抗性审查记录

> 2026-08-16 · 3 个独立审查 agent（前端 / 后端 / 安全），全部结论经代码引用或实证（SQLite 语义、EXPLAIN、真实 HTTP 请求）验证。
> 状态：已 triage。修复分 3 个 commit 推进；已知限制记录于文末。

## 前端审查（graph.js / graph.html）— 15 发现

| ID | 位置 | 级 | 问题 | 处置 |
|---|---|---|---|---|
| F1-1 | graph.js:522-525,637-656 | P1 | sim 收敛（'end'）后 state.sim=null → 拖拽只设 fx/fy 不重启物理 → **拖拽永久失效** | 修复：保留 stopped sim 引用，drag 时 lazy restart |
| F1-2 | graph.js:798,931,949 + common.js:332 | P1 | **escAttr 在双引号 HTML 属性中失效**（只转义 `\ ' "` 为 JS 字符串风格）：Linux 文件名含 `"` 可注入 onclick 属性 → 存储型 XSS | 修复：属性值改用 esc() |
| F1-3 | graph.js:1003-1035 | P2 | SSE 无 onerror：401（服务重启/token 过期）→ 每 ~3s 无限重连，永不恢复 | 修复：连续失败 → close + 一次性提示 |
| F1-4 | graph.js:428-461 | P2 | Promise.all 4 请求原子失败：一个失败（如 SQLITE_BUSY）→ 整图丢弃 | 修复：graph 独立渲染，orphans/broken 降级 |
| F1-5 | graph.js:1011-1034 | P2 | 重索引期间每秒 reload：view 重置（缩放丢失）、sim 永不收敛（5000 节点全 alpha 跑 20-30s）、file-tree:changed 无选择过滤 | 修复：保留 view、数据未变跳过重启、按选择过滤 |
| F1-6 | graph.js:431 vs routes:136 | P2 | orphans >10000 时与 stats 语义发散（多项目时整个后续项目落出窗口） | 修复：超过时显示"仅显示前 10000"提示 |
| F1-7 | graph.js:143-156 | P2 | hitTest 半径未乘 scale：scale=8 时只能点中节点中心 ~16% 面积；scale=0.05 时 20px 幽灵命中区 | 修复：`r = (n.radius+4)*view.scale` |
| F1-8 | graph.js:825-849 | P2 | focusNode 不 clamp，而滚轮路径 zoomAt+clampView → 聚焦后滚轮一次节点跳走 | 修复：focusNode 内 clamp |
| F1-9 | graph.js:672-682 | P3 | 右键点击节点误触 openDoc（无 e.button 守卫）；无 pointercancel → pointerup 丢失后拖拽卡死 | 修复：button===0 + pointercancel 清理 |
| F1-10 | graph.js:665,698-705 | P3 | 每 pointermove 3 次 O(n) 扫描（20k 节点 ≈ 1.5-3ms/事件） | 修复：hitTest 返回 node 对象 + hover 未变跳过重绘 |
| F1-11 | graph.js:290-297 | P3 | fetchJ 未接 AbortController signal → 快速切项目时旧大响应网络级浪费 | 修复：signal 透传 |
| F1-12 | graph.js:574 | P3 | 标签字体在世界坐标空间设置：scale=8 时 88px 大字重叠 | 修复：`(11/view.scale)px` |
| F1-13 | graph.js:561-567 | P3 | d3 加载失败降级：边 source/target 为字符串 → NaN → 只画节点不画边 | 修复：draw 时 byId 解析 |
| F1-14 | graph.js:756-782 | P3 | 搜索竞态：快速输入两次，旧响应后到覆盖新结果 | 修复：序列号守卫 |
| F1-15 | graph.js:479-527 | P3 | startSimulation 双 sim 竞态（loadD3Force 异步期间二次 loadData） | 修复：代次守卫 |

## 后端审查（routes/graph.ts / repository.ts）— 14 发现

| ID | 位置 | 级 | 问题 | 处置 |
|---|---|---|---|---|
| B-1 | G:203 | P1 | `limit=-1` → SQLite LIMIT 无上限 → 全量图返回（节点+边均突破 2000 上限），0.0.0.0 绑定下为内存/带宽 DoS | 修复：`Math.max(1, ...)` 下界 |
| B-2 | G:136,146,260 + R:196,346,373 | P1 | orphans/broken/backlinks/related 负 limit 同样绕过上限（related slice(0,-5) 返回除末 5 外全部，实证） | 修复：全部 clamp 点加下界 |
| B-3 | G:303-313 + I:205-222 | P1 | POST index 双重建：markProjectGraphDirty 5s 去抖计时器从未取消 → 立即执行 + 5s 后第二次全量（10k 文件 ≈ 20-30s ×2） | 修复：立即执行后取消 pending timer |
| B-4 | G:108-123 | P1 | 聚合路由无 LIMIT：50 万边 ≈ 100MB JSON 全序列化，truncated 只在 payload 已巨大时为 true | 修复：应用 FULL caps LIMIT |
| B-5 | G:225-239 | P2 | 子图边查询无 ORDER BY + LIMIT 窗口：>8000 边项目大部分锚点边静默缺失 | 修复：边查询限定 1-hop 端点集 |
| B-6 | G:74,79-85 + R:270-286 | P2 | `projects=` 超 16383 个 → 2n 占位符超 SQLite 上限 32766 → 500 | 修复：parseProjectIds 上限（≤100 → 400） |
| B-7 | G:154,74,136... | P2 | parseInt 宽松：`/api/graph/1.5` → 项目 1 静默错数据；`1e2` → 1 | 修复：严格整数 regex |
| B-8 | G:119,195,241 | P2 | JSON.parse(tags) 非防御：坏数据 → 整路由 500；`'null'` 字符串泄漏 null 到客户端 | 修复：try/catch → [] |
| B-9 | G:279 + related.ts | P2 | related 负 limit → slice(0,-5) 候选全返回（实证） | 修复：下界 clamp（并入 B-2） |
| B-10 | R:382-388 | P3 | broken 排序 ORDER BY updated_at DESC 无索引（EXPLAIN: USE TEMP B-TREE） | 记录（200k 边 ~10-30ms 可接受，不动迁移） |
| B-11 | G:121,198 | P3 | truncated `>=` vs `>`：恰好 20000 节点误报 truncated | 修复：改 `>` |
| B-12 | G:203-244 | P3 | 子图模式无 truncated 标志（mode=full 有） | 修复：LIMIT 命中时补标志 |
| B-13 | G:79-85 | P3 | `projects=1,1` → 404（COUNT IN (1,1)=1≠2）应去重 | 修复：parseProjectIds 去重 |
| B-14 | R:725-736 + 设计文档 | P3 | 注释/文档声称"status 进 PK 防撞"实际 PK 无 status | 修复：文档注释更正 |

## 安全审查（SSE ?token= 等）— 9 发现

| ID | 位置 | 级 | 问题 | 处置 |
|---|---|---|---|---|
| S-1 | app.ts:461-490 | P1 | **XFF 伪造**：隧道 running + open mode 下 `X-Forwarded-For: 127.0.0.1` → 全量 API 未认证访问（实证：XFF 127.0.0.1 → 200，8.8.8.8 → 401）。cloudflared 透传客户端 XFF 并追加真实 IP，代码信任首条目。既有问题，非本次引入 | 修复：仅当连接来源是本机（隧道代理本地转发）时才信任 XFF |
| S-2 | app.ts:469-478,3364-3380 | P2 | access_policy 'password' 配置存在但从未强制（只查 readonly） | 记录已知限制（平台隧道认证设计，改动面大） |
| S-3 | app.ts:449-501 + events.ts | P2 | SSE 仅连接时鉴权：revokeAllSessions 后活动流继续投递（实证）；logout/改密/30min TTL 均不断流 | 记录已知限制（单用户本地工具，修复成本高收益低） |
| S-4 | graph.js/preview.js SSE | P3 | 同 F1-3：401 无限重连 | 并入 F1-3 修复 |
| S-5 | app.ts:432-447 | P3 | token-in-URL 暴露面（performance entries / devtools / LAN 代理日志）——与 header+sessionStorage 同等暴露，可接受 | 记录 |
| S-6 | app.ts:3416-3473 | P3 | 登录限速器键控首条 XFF（与 S-1 同根源），XFF 轮换可绕过限速但 DB 级 15min 锁兜底 | 并入 S-1 修复（clientIp 同逻辑） |
| S-7 | app.ts:487 | P3 | 未认证 401 body 带 tunnelActive:true（确认隧道运行状态） | 记录（低风险） |
| S-8 | events.ts:23-28 | P3 | SSE 广播项目无关（所有客户端收全部项目事件） | 记录（单用户设计注记） |
| S-9 | app.ts:3795-3800 | P3 | SSE 连接数无上限（多 tab 钉住 watcher） | 记录 |

**已确认安全（cleared）**：`?token=` 窄范围正确——15 种路径规范化变体全部 fail-closed（实证）、SW 不缓存 /api/events、无副作用端点、header 优先、'1' 哨兵安全（token 为 64 hex）、token 不进浏览器历史、服务端无 URL 日志。

## 修复计划（3 个 commit）

1. **fix(graph): harden graph API limits + XFF trust boundary** — B-1/2/9、B-3、B-4、B-6、B-7、B-8、B-13、S-1/S-6、B-11、B-12、B-14
2. **fix(graph): subgraph edge window, truncated semantics** — B-5（并入 1 或 2，按实现顺序）
3. **fix(graph): frontend interaction + XSS + SSE resilience** — F1-1~F1-15 全部

每条修复带回归测试（Phase 2 先写失败测试）。验证链：format/lint/i18n/build/test。提交带 Co-Authored-By footer。

## 已知限制（记录，不修）

- access_policy 'password' 配置未强制（S-2，平台隧道认证设计问题）
- SSE 仅连接时鉴权：revoke/logout/TTL 不断活动流（S-3）
- broken 排序无索引（B-10，200k 边 ~10-30ms 可接受）
- SSE 项目级广播无过滤（S-8）、连接数无上限（S-9）
