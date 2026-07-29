# 远程访问隧道集成（移动端 L2） — 设计文档

> 日期: 2026-07-27 | 优先级: Q4-2 | 状态: 设计

## 一、背景与目标

当前移动端访问限制：**必须与 Doc77 服务器在同一局域网**。用户离开家/办公室后无法访问文档。

**目标**：集成安全隧道，让用户在外网也能通过手机访问自己的 Doc77 实例。

**核心约束**：
- **不运营 Doc77 云服务** — 隧道是用户自己的基础设施
- **端到端加密** — 内容在传输中不被第三方读取
- **用户显式授权** — 默认关闭，手动开启
- **临时性** — 关 App 即断，无持久公网暴露

## 二、方案对比

| 方案 | 原理 | 优势 | 劣势 | 选择 |
|------|------|------|------|------|
| **Cloudflare Tunnel** | cloudflared 客户端 → CF 边缘 → 用户 | 免费、DDoS 防护、自定义域名 | 需 CF 账号、域名 | ✅ 推荐 |
| **Tailscale** | WireGuard mesh，设备直连 | P2P 低延迟、零配置 NAT 穿透 | 需安装客户端、免费设备数限制 | ✅ 推荐 |
| **ngrok** | 临时公网 URL 隧道 | 零配置、即开即用 | 免费版域名随机、带宽限制 | 可选 |
| **frp** | 自建中继服务器 | 完全自控 | 需自备公网服务器 | 高级用户 |
| **自建 WireGuard** | 手动配置 VPN | 最安全 | 配置复杂 | 不集成 |

**策略**：集成 Cloudflare Tunnel + Tailscale 两种（覆盖 90% 用户），ngrok 作为快速临时选项。

## 三、Cloudflare Tunnel 集成

### 3.1 前置条件

- 用户拥有 Cloudflare 账号（免费）
- 用户拥有托管在 CF 的域名（可选，无域名用 `*.trycloudflare.com` 临时域名）
- 本机安装 `cloudflared`（Doc77 可辅助下载）

### 3.2 配置

```typescript
interface TunnelConfig {
  provider: 'cloudflare' | 'tailscale' | 'ngrok';
  enabled: boolean;
  // Cloudflare 特有
  cfToken?: string;           // Cloudflare Tunnel token（Named Tunnel）
  cfDomain?: string;          // 自定义域名（如 docs.example.com）
  quickTunnel: boolean;       // true = 临时 trycloudflare.com（无需配置）
  // Tailscale 特有
  tsHostname?: string;        // Tailscale 机器名
  tsFunnel: boolean;          // 是否启用 Tailscale Funnel（公网）
  // 通用
  accessPolicy: 'password' | 'token' | 'open';
  password?: string;          // accessPolicy=password 时
  allowedDevices: string[];   // 设备白名单（可选）
}
```

### 3.3 快速隧道（零配置模式）

```
用户点击 "开启远程访问"
  → Doc77 检测 cloudflared 是否已安装
    → 未安装 → 提示下载（或自动下载到 ~/.doc77/bin/）
  → 启动: cloudflared tunnel --url http://localhost:27777
  → 解析输出获取临时 URL: https://xxx-yyy.trycloudflare.com
  → 显示 QR 码 + URL
  → 手机扫码即可访问（需输入 Doc77 登录密码）
```

### 3.4 Named Tunnel（持久模式）

```
前置: 用户已在 CF Zero Trust 创建 Tunnel + 配置路由

Doc77 配置:
  1. 输入 Tunnel Token
  2. 启动: cloudflared tunnel run --token <TOKEN>
  3. 通过用户域名访问: https://docs.example.com
  4. 可选: CF Access Policy 额外认证层
```

### 3.5 生命周期管理

```typescript
class TunnelManager {
  private process: ChildProcess | null = null;

  async start(config: TunnelConfig): Promise<TunnelInfo> {
    // 1. 检查 cloudflared 可执行文件
    // 2. 启动子进程
    // 3. 监听 stdout 获取 URL
    // 4. 注册 shutdown hook（app 退出时 kill）
    // 5. 返回 { url, startedAt, provider }
  }

  async stop(): Promise<void> {
    // graceful kill cloudflared 进程
  }

  getStatus(): TunnelStatus {
    // running / stopped / error
  }
}
```

## 四、Tailscale 集成

### 4.1 模式

| 模式 | 访问范围 | 说明 |
|------|---------|------|
| **Tailnet 内** | 仅同 Tailnet 设备 | 最安全，设备间直连 |
| **Tailscale Funnel** | 公网可访问 | 类似 Cloudflare Tunnel |

### 4.2 实现

```
1. 检测 tailscale 是否已安装并登录
   → tailscale status --json
2. 将 Doc77 绑定到 Tailscale IP
   → 配置 bind_address = tailscale IP (100.x.y.z)
3. 或启用 Funnel:
   → tailscale funnel --bg 27777
4. 显示 Tailscale 域名: https://machine-name.tail-net.ts.net
```

### 4.3 优势

- 手机安装 Tailscale App → 自动在同一 Tailnet → 直接访问
- 无需端口转发、无需公网 IP
- WireGuard 加密，零信任

## 五、安全设计

### 5.1 认证层

远程访问时**强制要求认证**（即使本地配置了免登录）：

```
远程请求进入
  → 检查是否已有有效 session
  → 无 → 重定向到登录页
  → 登录 → 验证密码（复用现有 auth）
  → 成功 → 设置 session cookie（HttpOnly, Secure, SameSite=Strict）
```

### 5.2 访问控制

| 策略 | 说明 |
|------|------|
| 密码保护 | 远程访问必须输入 Doc77 登录密码 |
| 只读模式（可选） | 远程设备仅可预览，不可编辑/删除/审批 |
| 设备白名单 | 仅允许已配对设备访问 |
| 会话超时 | 远程 session 30min 无操作自动过期 |
| IP 限制（可选） | 仅允许特定 IP 段 |

### 5.3 隐私红线

- 隧道仅转发到 localhost，不暴露其他服务
- 不记录远程访问的文件内容（仅审计日志记录路径）
- 用户可随时一键关闭远程访问
- 关闭 Doc77 → 隧道自动断开

## 六、前端 UI

### 6.1 设置页 — 远程访问面板

```
┌─ 远程访问 ─────────────────────────────────────────────┐
│                                                         │
│  状态: ● 已开启  https://xxx.trycloudflare.com          │
│                                                         │
│  方式: (●) Cloudflare  ( ) Tailscale  ( ) ngrok        │
│                                                         │
│  ┌─ QR 码 ─┐                                           │
│  │  █████  │  ← 手机扫码连接                            │
│  │  █████  │                                           │
│  └─────────┘                                           │
│                                                         │
│  访问策略:                                              │
│  [✓] 需要密码登录                                       │
│  [✓] 远程只读（不可编辑/删除）                          │
│  [ ] 设备白名单                                         │
│  会话超时: [30] 分钟                                    │
│                                                         │
│  [关闭远程访问]                                         │
│                                                         │
│  ─── 连接设备 ───                                       │
│  📱 iPhone 15 — 在线 — 10:30 最后活跃                   │
│  💻 iPad Pro — 离线 — 昨天 22:15                        │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Dashboard 远程状态指示

```
顶栏右侧:
  🌐 远程访问已开启 (点击管理)
  或
  🔒 仅本地访问
```

## 七、API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/tunnel/status` | 隧道状态 |
| POST | `/api/tunnel/start` | 启动隧道 |
| POST | `/api/tunnel/stop` | 停止隧道 |
| PUT | `/api/tunnel/config` | 更新配置 |
| GET | `/api/tunnel/devices` | 已连接设备列表 |

## 八、cloudflared 管理

### 8.1 自动下载

```typescript
async function ensureCloudflared(): Promise<string> {
  const binPath = path.join(homedir, '.doc77', 'bin', 'cloudflared');
  if (await exists(binPath)) return binPath;

  // 根据平台下载
  const url = {
    'win32-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    'darwin-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
    'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  }[`${process.platform}-${process.arch}`];

  // 下载 + 校验 + 设置可执行权限
  await download(url, binPath);
  return binPath;
}
```

### 8.2 进程管理

- 启动时 spawn 子进程
- 监听 stdout 解析 URL（Quick Tunnel 模式）
- 心跳检测（每 30s 检查进程存活）
- 异常退出 → 自动重启（最多 3 次）
- App shutdown → kill 子进程

## 九、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/core/src/tunnel/manager.ts` | 新增 | TunnelManager 主类 |
| `packages/core/src/tunnel/cloudflare.ts` | 新增 | Cloudflare 适配器 |
| `packages/core/src/tunnel/tailscale.ts` | 新增 | Tailscale 适配器 |
| `packages/core/src/tunnel/ngrok.ts` | 新增 | ngrok 适配器 |
| `packages/core/src/server/app.ts` | 修改 | 隧道 API 路由 + 远程访问强制认证 |
| `packages/core/src/web/js/settings.js` | 修改 | 远程访问设置面板 |
| `packages/core/src/web/css/app.css` | 修改 | 远程状态指示样式 |

## 十、验收标准

1. 点击"开启远程访问" → 30s 内获得公网 URL + QR 码
2. 手机 4G 网络扫码 → 登录 → 正常浏览文档
3. 远程设备无法执行写操作（只读模式）
4. 关闭 Doc77 → 隧道自动断开 → URL 失效
5. 未登录直接访问 URL → 重定向到登录页
6. Tailscale 模式：同 Tailnet 设备直连访问
7. 会话 30min 超时 → 需重新登录
