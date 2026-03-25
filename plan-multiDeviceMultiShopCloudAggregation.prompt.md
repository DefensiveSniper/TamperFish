## Plan: TamperFish 多设备多店云端聚合架构

**TL;DR**: 将 TamperFish 从「本地单机单店」演进到「多设备 × 多 Chrome × 多店铺 → 云端聚合 → 统一收发」。采用 **Edge-Cloud 分离架构**：每台设备运行轻量 Edge Agent 管理多个 Chrome 实例（各自独立网络代理），所有 Agent 通过安全 WSS 连接到云端 API（Node.js + PostgreSQL），React 控制台统一管理全部店铺消息收发。

分 6 个阶段递进实施，前 3 阶段可支撑 MVP（单设备多店 + 云端）。

---

### 整体架构

```
┌───────────────────────────────────────────┐
│            Cloud Server (VPS)              │
│                                           │
│  React SPA ◄──► Express API ◄──► PG       │
│                    │                       │
│             WSS Hub (认证+路由)             │
│                    │                       │
│         AI Worker ◄──► LLM API            │
└──────────┬─────────────────┬──────────────┘
           │ WSS (TLS+Token) │
     ┌─────┴─────┐     ┌────┴──────┐
     │  Device-1  │     │  Device-2  │
     │ Edge Agent │     │ Edge Agent │
     │            │     │            │
     │ Chrome-A ──┤     │ Chrome-D ──┤
     │ (shop1     │     │ (shop4     │
     │  proxy:p1) │     │  proxy:p4) │
     │            │     │            │
     │ Chrome-B ──┤     │ Chrome-E ──┤
     │ (shop2     │     │ (shop5     │
     │  proxy:p2) │     │  proxy:p5) │
     └────────────┘     └────────────┘
```

### 核心概念

| 概念 | 定义 |
|---|---|
| **Edge Agent** | 运行在物理设备上的 Node.js 进程，管理该设备上的多个 Chrome 实例，负责消息采集执行和发送执行 |
| **Shop Worker** | Agent 内为每个店铺启动的独立管理单元（Chrome 进程 + Extension + CDP sync） |
| **Cloud API** | 中心化 Express + PostgreSQL 服务，聚合所有数据，分发任务 |
| **WSS Hub** | 云端 WebSocket 中枢，Token 认证 + 按 `device_id × shop_id` 路由 |

---

### Phase 0: 编译修复 + 单店跑通

> 先让 Chrome Extension 能完整替代油猴脚本

0.1 修复 `sync.ts` 类型错误（`mergeProductInfo` 默认值）
0.2 验证 `tsc --noEmit` 零错误 + 三入口 vite build
0.3 Chrome 加载 → 端到端：采集 + WSS + 发送回路
0.4 消除 `escapeHtml` 重复（`panel.ts` → `dom.ts`）

---

### Phase 1: 多店配置 + Edge Agent — 单设备多 Chrome

> 一台机器跑 N 个 Chrome，每个对应一个店+代理

**1.1 定义 shops 配置** — 新建 `server/config/shops.example.json`：
```json
{ "shops": [{
    "shopId": "shop_001", "shopName": "店铺A", "enabled": true,
    "chromeUserDataDir": ".chrome-profiles/shop_001",
    "proxy": "socks5://user:pass@proxy1:1080",
    "cdpPort": 18801
}]}
```

**1.2 重构 start.js → 多实例启动器** — 循环为每个 shop 启动独立 Chrome 进程（独立 profile + proxy + CDP 端口），维护 `shopProcesses` Map

**1.3 WSS 连接注册 shop 身份** — Extension 连接时 URL 带 `?shopId=xxx`（自动从 Fiber ownerInfo 提取），服务端维护 `connections` Map: `shopId → socket`

**1.4 DB 加 shop_id 字段** — sessions / messages / outgoing_messages 均增加 `shop_id TEXT`

**1.5 Claim 按 shop 路由** — `claimOutgoingMessage(shopId)` 加 `WHERE shop_id = ?`，杜绝串店发送

**1.6 店铺身份自动提取** — Content Script 从 `sessionInfo.ownerInfo` 读取 userId + nickName

---

### Phase 2: 云端服务 + Edge-Cloud 通信

> 数据上云，多设备接入

**2.1 拆分代码库**：
```
cloud/          ← 从 server/ 演进（API + DB + AI + WSS Hub）
edge-agent/     ← 新建（Chrome 管理 + 本地同步 + WSS 上行客户端）
chrome_extension/ ← 不变
frontend/       ← 部署到 cloud
```

**2.2 Edge Agent 设计**（`edge-agent/`）：
- `agent.js` — 主进程：读 shops 配置 → 启动多 Chrome → 管理生命周期
- `chrome-manager.js` — Chrome 进程管理（从 start.js 提取）
- `uplink.js` — WSS 客户端连接云端
- `local-sync.js` — CDP → 数据通过 uplink 推云端

**2.3 Edge-Cloud WSS 协议**：
```
Edge → Cloud:
  agent.register   { deviceId, token, shops }
  agent.heartbeat  { deviceId, shops: [{shopId, status}] }
  data.ingest      { shopId, sessions, messages }
  outgoing.report  { messageId, status }

Cloud → Edge:
  outgoing.dispatch { messageId, shopId, content, type }
  command.crawl     { shopId }
```

**2.4 Token 认证** — `deviceId + token` 对，握手时验证

**2.5 PostgreSQL 迁移** — 从 SQLite 迁移核心表，增加 `shop_id`, `device_id` 字段，claim 改为原子 `UPDATE ... RETURNING *`

**2.6 云端 WSS Hub** — 维护 `agentConnections: Map<deviceId, {socket, shops}>`，dispatch 时按 shopId 找到对应 agent

---

### Phase 3: 用户端 Web 平台（React 多店消息收发中心）

> 基于 React 构建完整的用户端 Web 平台，用户在浏览器中即可实现多店铺消息的统一收发和管理

#### 3.A 整体页面布局

```
┌──────────────────────────────────────────────────────────────┐
│  TopBar: Logo · 全局搜索 · 通知铃铛 · 用户头像/设置          │
├────────┬─────────────────────────────────┬───────────────────┤
│ Shop   │        ChatPanel               │   InfoPanel       │
│ Rail   │                                │                   │
│        │ ┌─────────────────────────────┐ │ ┌───────────────┐ │
│ [全部] │ │  ChatHeader                 │ │ │ 买家信息      │ │
│ [店A]● │ │  店铺A · 买家昵称 · 商品名   │ │ │ userId/昵称   │ │
│ [店B]● │ ├─────────────────────────────┤ │ │ 历史订单数    │ │
│ [店C]○ │ │                             │ │ ├───────────────┤ │
│        │ │  MessageList                │ │ │ 商品卡片      │ │
│────────│ │  · 文字气泡                  │ │ │ 标题/价格/图  │ │
│Sessions│ │  · 图片(缩略图+放大)         │ │ ├───────────────┤ │
│ List   │ │  · 系统消息(灰条)           │ │ │ 关联订单      │ │
│        │ │  · AI 标记(机器人图标)       │ │ │ 状态/物流     │ │
│ 🔍搜索 │ │                             │ │ ├───────────────┤ │
│ 未读 3 │ ├─────────────────────────────┤ │ │ 快捷操作      │ │
│ 待回 2 │ │  ReplyBar                   │ │ │ · 标记已处理  │ │
│        │ │  [输入框] [图片] [模板] [发]  │ │ │ · 转交他人    │ │
│ chat1  │ │  AI 建议回复(可一键采用)      │ │ │ · 加备注      │ │
│ chat2  │ └─────────────────────────────┘ │ └───────────────┘ │
│ chat3  │                                │                   │
│ ...    │  OutgoingQueue (可折叠)         │                   │
│        │  [发送中] [排队中] [失败重试]    │                   │
└────────┴─────────────────────────────────┴───────────────────┘
```

**响应式设计**：移动端折叠为 ShopRail → SessionList → ChatPanel 三级导航，滑动切换

#### 3.B 核心页面与组件

**3.1 ShopRail（店铺导航栏）**
- 左侧竖向店铺列表，图标+名称+在线状态（●绿 ○灰）
- "全部"模式：聚合所有店铺会话，按最后消息时间排序
- 单店模式：过滤只看该店铺会话
- 未读角标聚合：每个店铺显示独立未读数
- 底部：设备/店铺管理入口
- 组件: `frontend/src/components/ShopRail/ShopRail.tsx`

**3.2 SessionList（会话列表）**
- 实时更新的会话列表，显示：店铺标签、买家昵称、商品缩略图、最后消息预览、时间、未读数
- 筛选维度：全部 / 未读 / 待回复（最后是买家消息且无 pending outgoing）/ AI 待审核
- 搜索：按买家昵称、商品名、消息内容全文搜索
- 排序：最新消息时间（默认）/ 未读优先 / 待回复优先
- 置顶/标星功能
- 组件: `frontend/src/components/SessionList/SessionList.tsx`

**3.3 ChatPanel（聊天面板）**
- **ChatHeader**: 当前店铺名+标签色、买家昵称（点击查看详情）、商品名+链接、在线状态
- **MessageList**: 
  - 文字消息：左右气泡（买家/卖家），AI 发送的消息带机器人图标
  - 图片消息：缩略图 + 点击放大灯箱
  - 系统消息：居中灰色条
  - 订单卡片消息：结构化卡片展示
  - 时间分割线（超过 5 分钟间隔自动插入）
  - 无限上拉加载历史消息
- **ReplyBar**:
  - 多行文本输入框（Ctrl+Enter 发送）
  - 图片上传按钮（拖拽/粘贴/点选）
  - 快捷回复模板选择器
  - AI 建议回复条：当 AI Worker 生成了建议回复时，在输入框上方显示紫色建议条，一键采用或编辑
  - 发送按钮：明确显示将通过哪个店铺发送
- **OutgoingQueue**（可折叠面板）: 显示当前会话的排队/发送中/失败消息，失败的可一键重试
- 组件: `frontend/src/components/ChatPanel/`（扩展现有）

**3.4 InfoPanel（右侧信息面板）**
- **买家信息区**：昵称, userId, 首次联系时间, 历史会话数, 标签
- **商品卡片**：图片、标题、价格、链接（点击跳转闲鱼）
- **关联订单**：订单状态、物流追踪、付款时间、发货倒计时
- **快捷操作**：标记已处理、转交（多店场景下转给其他店铺客服）、加备注、拉黑
- 桌面端默认展开，移动端抽屉打开
- 组件: `frontend/src/components/InfoPanel/InfoPanel.tsx`

**3.5 管理后台页面**
- **设备管理** (`/admin/devices`):
  - 设备列表卡片：设备ID、状态、最后心跳、该设备上的 Chrome 数、店铺数
  - 每个设备可展开查看所属的 Chrome 实例和店铺
- **店铺管理** (`/admin/shops`):
  - 店铺列表表格：名称、设备(分配)、代理地址、在线状态、今日消息数、待发队列、操作
  - 新增/编辑店铺配置（shopId, proxy, Chrome profile 等）
  - 启用/禁用开关
- **AI 配置** (`/admin/ai`):
  - 全局 AI 自动回复开关
  - 按店铺独立配置 AI 策略（是否启用、自定义 prompt、回复审核模式）
  - AI 回复日志和准确率统计
- **消息模板** (`/admin/templates`):
  - 创建/编辑/删除快捷回复模板
  - 支持变量插值：`{买家昵称}`, `{商品名}`, `{价格}` 等
  - 按店铺或全局设置模板分组
- 组件: `frontend/src/components/Admin/`

#### 3.C 实时通信架构

```
Cloud API ──► SSE/WebSocket ──► React SPA（用户浏览器）
```

- 用户端 React SPA 通过 **Server-Sent Events (SSE)** 或 **WebSocket** 接收实时更新
- 事件类型：
  - `session.updated` — 新消息到达，更新会话列表 + 消息列表
  - `session.new` — 新会话创建
  - `outgoing.statusChanged` — 待发消息状态变化（pending → sending → sent/failed）
  - `shop.statusChanged` — 店铺上线/离线
  - `device.statusChanged` — 设备上线/离线
- 实现: 在 Cloud API 新增 `GET /api/events` SSE 端点（或 `ws://cloud/ws/console`）
- 前端通过 `useEventSource()` hook 订阅，收到事件后 dispatch 到 AppContext reducer

#### 3.D 前端状态管理升级

现有 `AppContext.tsx` 的 `useReducer` 方案扩展：

```typescript
// 新增 State 结构
interface AppState {
  // 现有
  sessions: Session[];
  currentChatKey: string | null;
  messages: Message[];
  settings: AppSettings;
  
  // 新增：多店
  shops: Shop[];
  devices: Device[];
  activeShopId: string | null;      // null = 全部店铺
  sessionFilters: {
    status: 'all' | 'unread' | 'pending_reply' | 'ai_review';
    search: string;
    sortBy: 'latest' | 'unread_first' | 'pending_first';
  };
  
  // 新增：实时
  sseConnected: boolean;
  unreadCounts: Record<string, number>;  // shopId → count
}

// 新增 Actions
type Action =
  | { type: 'SET_SHOPS'; shops: Shop[] }
  | { type: 'SET_DEVICES'; devices: Device[] }
  | { type: 'SET_ACTIVE_SHOP'; shopId: string | null }
  | { type: 'SET_SESSION_FILTER'; filters: Partial<SessionFilters> }
  | { type: 'SSE_SESSION_UPDATED'; session: Session; message?: Message }
  | { type: 'SSE_OUTGOING_STATUS'; messageId: number; status: string }
  | { type: 'SSE_SHOP_STATUS'; shopId: string; isOnline: boolean }
  | ... // 现有 actions
```

#### 3.E TypeScript 类型扩展

```typescript
// frontend/src/types/api.ts 新增

interface Shop {
  shopId: string;
  shopName: string;
  deviceId: string;
  isOnline: boolean;
  lastHeartbeat: string;
  proxy: string;           // 代理地址（脱敏，只显示 host:port）
  messageCountToday: number;
  pendingOutgoingCount: number;
  aiEnabled: boolean;
  createdAt: string;
}

interface Device {
  deviceId: string;
  isOnline: boolean;
  lastHeartbeat: string;
  shopCount: number;
  chromeCount: number;
  os: string;              // 设备操作系统
  ip: string;              // 设备出口 IP（脱敏）
}

interface ReplyTemplate {
  id: number;
  name: string;
  content: string;         // 支持 {变量} 插值
  shopId: string | null;   // null = 全局模板
  category: string;
  sortOrder: number;
}

// 现有类型扩展 shop_id
interface Session {
  // ... 现有字段
  shop_id: string;
  shop_name: string;
  is_starred: boolean;
  tags: string[];
}

interface Message {
  // ... 现有字段
  shop_id: string;
  media_url: string | null;
  media_type: string | null;
}
```

#### 3.F API 扩展清单

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/shops` | 列出所有店铺及状态 |
| `POST` | `/api/shops` | 新增店铺配置 |
| `PATCH` | `/api/shops/:shopId` | 更新店铺配置 |
| `DELETE` | `/api/shops/:shopId` | 删除店铺 |
| `GET` | `/api/devices` | 列出所有设备及状态 |
| `GET` | `/api/sessions?shopId=&status=&search=&sort=` | 会话列表(增强过滤) |
| `GET` | `/api/sessions/:chatKey/messages?before=&limit=` | 分页加载历史消息 |
| `POST` | `/api/outgoing-messages` | 发送消息（必传 shopId） |
| `GET` | `/api/events` | SSE 实时事件流 |
| `GET` | `/api/templates` | 列出回复模板 |
| `POST` | `/api/templates` | 创建模板 |
| `PATCH` | `/api/templates/:id` | 更新模板 |
| `DELETE` | `/api/templates/:id` | 删除模板 |
| `GET` | `/api/stats/overview` | 总览统计（今日消息数、活跃会话、各店铺统计） |
| `POST` | `/api/sessions/:chatKey/star` | 置顶/取消置顶 |
| `POST` | `/api/sessions/:chatKey/tags` | 管理会话标签 |

#### 3.G 前端路由设计

```
/                          → 重定向到 /chat
/chat                      → 主聊天界面（ShopRail + SessionList + ChatPanel + InfoPanel）
/chat/:shopId              → 过滤到某店铺的聊天界面
/chat/:shopId/:chatKey     → 打开特定会话
/admin/devices             → 设备管理
/admin/shops               → 店铺管理
/admin/ai                  → AI 配置
/admin/templates           → 消息模板
/admin/stats               → 数据统计面板
```

#### 3.H 用户认证（Web 平台）

- 云端部署后 React SPA 需要登录保护
- MVP 方案：简单用户名+密码，JWT token 存 localStorage
- `POST /api/auth/login` → 返回 JWT
- 前端 `ProtectedRoute` 组件包裹所有路由
- JWT 过期自动跳转登录页
- 后续可扩展：多角色（管理员/客服）、操作权限控制

---

### Phase 4: 多消息类型全面支持

> 覆盖闲鱼所有消息格式

**4.1 消息类型扩展** — `text | image | video | voice | card | order | system | emoji`

**4.2 图片/媒体代理** — Edge 本地下载 CDN 图片 → 上传到云端对象存储 → 控制台展示代理 URL（解决闲鱼 CDN 防盗链）

**4.3 发送增强** — 图片通过 `ClipboardItem` + 模拟粘贴注入；扩展 `sender.ts`

**4.4 DB 扩展** — messages 加 `media_url`, `media_type`, `metadata` 字段

---

### Phase 5: 健壮性与运维

**5.1 Edge 断线缓冲** — 本地 SQLite 作离线队列，恢复后批量同步

**5.2 告警系统** — 店铺离线、发送失败率超阈值、代理不通 → 告警

**5.3 日志审计** — 关键操作上报云端，消息发送全链路可追踪

**5.4 代理健康检查** — 周期探测每个 Chrome 代理连通性

---

### Phase 6: Docker 一键部署

**6.1 云端** — `docker-compose.yml`（API + PG + Nginx TLS）

**6.2 Edge Agent** — 提供 `install.sh` + systemd service（Chrome headful 需桌面环境，不适合纯容器）

**6.3 配置分离** — 全部通过 `.env` + `shops.json` 驱动

---

### 验证总览

| Phase | 关键验证 |
|---|---|
| P0 | `tsc` + build + Chrome 加载 + 单店完整收发 |
| P1 | 单机 2 Chrome（不同 profile/proxy）→ 各自独立采集 → DB 含 shop_id |
| P2 | Edge → 云端 WSS → PG 入库 → 云端下发 → Edge 执行发送 |
| P3 | 控制台多店切换 + 聚合 + 跨店发 |
| P4 | 图片采集 → 展示 → 发送 |
| P5 | 断网 → 缓冲 → 恢复 → 数据完整 |
| P6 | `docker-compose up` 一键跑通 |

### 关键决策

- **Edge-Cloud 分离**：Edge 负责 Chrome 管理和发送执行，Cloud 负责聚合存储和控制分发
- **shop_id 贯穿全链路**：Extension → Edge → Cloud → DB → UI → outgoing → Edge → Extension
- **PostgreSQL** 云端，SQLite 仅做 Edge 离线缓冲
- **每 Chrome 独立代理**：`--proxy-server` 参数由 shops 配置驱动
- **Token 认证**：MVP 阶段简单有效，后续可升 JWT
- **Phase 0-1 在现有 server/ 上改**，Phase 2 才拆分为 cloud/ + edge-agent/

### 主要风险

| 风险 | 对策 |
|---|---|
| 闲鱼前端改版（CSS hash 变化） | Fiber-first 策略 + CSS 作 fallback + 版本检测告警 |
| 代理 IP 封禁 | 每店独立代理 + 健康检查 + 切换告警 |
| Chrome 内存（~500MB-1GB/实例） | 配置文档明确硬件要求（8GB 最多 5-6 Chrome） |
| 图片 CDN 防盗链 | Edge 本地代理下载 → 上传云端 OSS |
| WSS 网络延迟 | Edge 本地缓冲 + 异步批量上报（3-5s 批次） |

---

**建议实施顺序**：P0 → P1 → P2 → P3 为优先路径（大约覆盖了 80% 的核心价值）。P4-P6 可并行或按需插入。P0-P1 是在现有代码上增量改动，改动量可控；P2 是最大的架构跃迁点。
