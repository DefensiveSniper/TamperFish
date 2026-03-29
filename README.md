# TamperFish

TamperFish 是一个面向闲鱼卖家场景的本地工作台，目标是把聊天采集、订单采集、人工接管、AI 自动回复和统一控制台收敛到同一套本地系统里。

当前仓库的主链路是：

- `chrome_extension/` 在 `https://www.goofish.com/im` 侧采集聊天、执行发送动作
- `qianniu_capture/` 在千牛待发货页采集订单
- `server/` 提供 HTTP API、WSS RPC、SQLite 持久化、媒体缓存和自动回复 Worker
- `server/frontend/` 提供 React 管理控制台，构建产物输出到 `server/public/`

## 当前状态

- 当前推荐按职责拆分运行：`server` 负责服务端能力，`client` 负责本地 Chrome 客户端能力
- `chrome_extension/` 和 `qianniu_capture/` 都属于浏览器侧模块，由客户端拉起的 Chrome 承载
- 本地 client 的实际启动入口已经切换为 `start.js`，`npm start` 走的是 `node start.js`，不再依赖直接执行 `start.ts`

## 相对之前版本的修改

下面这部分是针对之前版本的增量说明，优先描述这轮已经落地的行为变化，便于和旧版 README 对照使用。

### 1. 本地 client 与交付包

- `client/` 与 `deploy/local-client-package/client/` 的启动入口已经统一为 `start.js`
- `deploy/local-client-package/` 是当前推荐的本地端交付目录，包含：
  - `client/`
  - `chrome_extension/dist/`
  - `load_env.ts`
- 交付包不能只拷贝入口文件，`sync.ts`、`browser_bridge_actions.ts`、`chrome_tls.ts`、`media_cache.ts`、`load_env.ts` 等运行时依赖都必须保留
- 当前约定：后续面向本地部署的 client 修改，以 `deploy/local-client-package/` 为准

### 2. client 标识与鉴权

- 不再使用历史默认 client `legacy-client-1`
- server 启动时会主动清理这个历史默认 client，因此继续使用它会导致 `/api/messages/ingest`、`/api/browser/heartbeat` 等接口返回 `401 unauthorized`
- `CLIENT_ID` 现在必须显式配置为真实机器的唯一标识；同一店铺的多台机器共享 `ACCOUNT_ID`，但不能共享 `CLIENT_ID`
- 浏览器侧与本地 client 发往 server 的请求头，已经对非 Latin-1 内容做 URL 编码，避免中文店铺名 / client id 触发浏览器 `String contains non ISO-8859-1 code point` 错误

### 3. 初始遍历与命令链路

- server 现在会在运行时设置里下发 `initialCrawlNonce`
- `client/start.js` 与扩展内容脚本已经补齐初始遍历命令链路：
  - client 轮询 `/api/browser/heartbeat`
  - 扩展暴露 `window.__tamperfishRunInitialConversationSync`
  - client 通过 CDP 调用页面内的初始遍历函数
- 控制台顶部的“初始遍历”按钮现在对应的是这条新链路，而不是旧版的手工临时脚本

### 4. 聊天同步与会话归并

- server 侧会话归并逻辑已经收紧，当前只在 `session_id` 明确匹配时复用既有 `chat_key`
- 之前按 `buyer_user_id + product_id` 或按“客户名 + 消息快照”做模糊归并的逻辑，已经移除，因为它会把不同会话错误合并到一起
- server 现在会额外清理形如 `_<productId>` 的匿名脏会话 key，避免侧边栏出现“正常会话 + 空名称会话”双份记录

### 5. 图片链路与 media-cache

- `/media-cache/` 已调整为在浏览器登录鉴权之前提供访问，避免图片请求被 `302` 重定向到 `/login`
- 前端会把历史库里残留的旧 host / 旧局域网地址图片 URL 归一化到当前 server origin
- 同机部署时，前端不会再把 `http://127.0.0.1:3210/media-cache/...` 误判成“未同步到服务器”的坏图
- 本地 client / 交付包已经补齐浏览器侧图片缓存恢复逻辑，`client/.browser-media-cache/` 与 manifest 可用于把浏览器抓到的图片重新映射回 server 可访问的缓存文件
- 如果数据库里只剩失效的本地桥接 URL，而 server 上又没有对应缓存文件，历史图片仍然需要通过重拉或从本地缓存回填恢复；这不是前端渲染问题，而是历史数据缺失问题

### 6. 发送消息体验

- 文本消息与图片消息都已经改成“先本地乐观显示，再等待 server / 浏览器侧确认”的模式
- 前端新增本地 `localOutgoingByChat` 状态层，用来减少旧版本里“发送后先出现一条，成功后旧气泡消失，再出现一条新气泡”的闪烁问题
- 文本消息现在会尽量保持单气泡，并在右下角持续显示发送状态
- 图片消息发送时，前端会优先使用 `media_data` 直接显示本地预览，而不是只显示一个空状态气泡
- server 侧 `messages` 已新增 `outgoing_message_id` 关联字段，用于把真实入库消息和 outgoing 队列绑定，减少 sent/outgoing 双份显示

### 7. 引用、图片预览与聊天体验

- 点击聊天图片不再新开标签页，而是在当前页弹出预览层
- 引用消息卡片已经统一了文字 / 图片的视觉层级
- 点击引用卡片可以定位到原消息，并对原消息做短暂高亮
- 回复内容去重逻辑已经增强，覆盖了旧版本里常见的几类重复：
  - `引用 XXX 的消息` 头部重复
  - `我` 与店铺名别名等价但重复出现
  - “作者行 + 被引用正文 + 新回复正文” 三段式重复
  - 图片引用场景下正文前多出一行自己的名字

### 8. 搜索能力

- 左上角搜索框不再只按会话名过滤
- 现在支持按以下内容做模糊搜索：
  - 买家名称
  - `chat_key`
  - 商品 id
  - 历史消息正文
- 搜索结果会返回命中的历史消息片段，并在侧边栏高亮命中文本
- 点击搜索结果后，不仅会切换到对应会话，还会自动定位到会话内命中的那条历史消息

### 9. 前端构建说明修正

- 之前 README 中关于 `server/frontend` Node 版本要求的说明已经过时
- 当前仓库已经把 `vite` / `@vitejs/plugin-react` 调整到可在本机 Node 20.11.1 下完成构建的版本
- 因此当前这台机器上，`server/frontend` 可以直接执行构建，不再需要先升级到 Node 20.19+

## 功能概览

- 实时采集闲鱼聊天会话与消息
- 将千牛待发货订单同步到本地数据库，并尝试和会话做关联
- 在本地控制台集中查看会话、订单、运行状态和待发送队列
- 支持人工发送消息，也支持基于 LLM 的自动回复入队
- 支持图片消息媒体缓存，避免前端直接依赖远端图片地址

## 架构

```text
Goofish Web IM
  │
  └── Chrome Extension ─────┐
                            │ WSS RPC
Qianniu Batch Consign       │
  │                         ▼
  └── Tampermonkey Script ─ Server
                              ├── Express API
                              ├── Browser WSS RPC
                              ├── SQLite
                              ├── Media Cache
                              ├── Auto Reply Worker
                              └── React Console (server/public)
```

## 目录说明

| 路径 | 角色 | 状态 |
|---|---|---|
| `server/` | 后端服务、WSS、数据库、自动回复 Worker、控制台静态资源 | 当前主链路 |
| `server/frontend/` | React 控制台源码，构建后输出到 `server/public/` | 当前主链路 |
| `client/` | 本地 Chrome 启动器、远程 WSS 注入、CDP 辅助同步 | 当前主链路 |
| `chrome_extension/` | 闲鱼聊天采集与发送 Chrome 扩展 | 当前主链路 |
| `qianniu_capture/` | 千牛订单采集 Tampermonkey 脚本 | 当前主链路 |
| `xianyu_capture/` | 旧版闲鱼采集脚本 | 旧链路 |
| `types/` | 共享类型声明 | 辅助目录 |
| `integrations/` | 预留扩展目录 | 预留 |

## 当前主链路启动

### 1. 前置要求

- Node.js 18 及以上
- Chrome 浏览器
- OpenSSL
- Tampermonkey

### 2. 安装依赖

```bash
cd server && npm ci && cd ..
cd server/frontend && npm ci && cd ../..
cd client && npm ci && cd ..
cd chrome_extension && npm ci && cd ..
```

### 3. 环境变量

先准备本地配置文件：

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

当前入口脚本已经内置 `.env` 自动加载逻辑，并且保留“显式传入的系统环境变量优先”这一规则：

- `server/index.ts`、`server/auto_reply_worker.ts`、`server/ai.ts` 会加载 `server/.env`
- `client/start.js`、`client/start.ts`、`client/sync.ts` 会加载 `client/.env`

服务端常用变量如下：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3210` | HTTP API 端口 |
| `SERVER_BIND_HOST` | `0.0.0.0` | HTTP / WSS 监听地址 |
| `BROWSER_WSS_PORT` | `3211` | 浏览器脚本连接的 WSS 端口 |
| `BROWSER_WSS_PATH` | `/ws/browser` | 浏览器 RPC 路径 |
| `CORS_ALLOWED_ORIGINS` | 空 | 额外允许的来源，逗号分隔 |
| `BROWSER_WSS_CERT_PATH` | 自动生成 | 自定义 TLS 证书路径 |
| `BROWSER_WSS_KEY_PATH` | 自动生成 | 自定义 TLS 私钥路径 |
| `BROWSER_WSS_CERT_SAN` | 空 | 追加 SAN，例如 `IP:192.168.1.100` |
| `BROWSER_MEDIA_ORIGIN` | 自动推导 | 图片缓存的公开访问地址 |
| `OPENAI_API_KEY` | 空 | 自动回复所需的 API Key |
| `OPENAI_BASE_URL` | `https://api.openai.com` | LLM API Base URL |
| `OPENAI_MODEL` | `gpt-4o` | 自动回复模型 |
| `AUTO_REPLY_ENABLED` | `1` | 自动回复开关 |
| `AUTO_REPLY_INTERVAL_MS` | `3000` | Worker 轮询间隔 |
| `CRAWLER_DESIRED_ENABLED` | `1` | 期望浏览器巡逻状态 |

客户端常用变量见 [`client/.env.example`](client/.env.example)。

#### 多客户端部署

系统支持多个客户端实例连接同一个服务端。每个客户端需要在 `client/.env` 中配置唯一身份：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CLIENT_ID` | `shop-a-client-1` | 客户端唯一标识，每个实例必须不同 |
| `CLIENT_SECRET` | 空 | 可选鉴权密钥 |
| `ACCOUNT_ID` | `default` | 所属卖家账号标识，同一卖家的多个客户端填相同值 |
| `CLIENT_NAME` | 空 | 前端显示名称 |

说明：

- `CLIENT_ID` 不要再使用 `legacy-client-1`
- 推荐改成真实机器标识，例如 `shop-a-client-1`、`shop-a-macbook`、`纯粹衣饰-本机`
- `CLIENT_NAME` 只是展示名，可以包含中文；`CLIENT_ID` 需要保证唯一

**同一卖家多台机器**示例——共享 `ACCOUNT_ID`，会话数据互通：

```bash
# 机器 A: client/.env
CLIENT_ID=shop-a-pc-1
ACCOUNT_ID=shop-a
CLIENT_NAME=店铺A-主力机

# 机器 B: client/.env
CLIENT_ID=shop-a-pc-2
ACCOUNT_ID=shop-a
CLIENT_NAME=店铺A-备用机
```

**多个卖家**示例——不同 `ACCOUNT_ID`，数据隔离，前端可切换：

```bash
# 卖家 A: client/.env
CLIENT_ID=shop-a-client
ACCOUNT_ID=shop-a
CLIENT_NAME=店铺A

# 卖家 B: client/.env
CLIENT_ID=shop-b-client
ACCOUNT_ID=shop-b
CLIENT_NAME=店铺B
```

客户端启动时会自动向服务端注册（`POST /api/clients/register`），无需手动操作。服务端不需要为多客户端增加任何配置。

### 4. 构建前端和扩展

```bash
# 构建控制台，产物输出到 server/public/
cd server/frontend && npm run build && cd ../..

# 构建 Chrome 扩展，必须先生成 chrome_extension/dist/ 才能在浏览器里加载使用
cd chrome_extension && npm run build && cd ..
```

### 5. 启动服务端

服务端只负责本地 API、WSS、数据库、媒体缓存、自动回复 Worker 和控制台静态资源：

```bash
cd server && npm start && cd ..
```

启动后默认会提供：

- 监听地址：`0.0.0.0`（由 `SERVER_BIND_HOST` 控制，默认值见 `server/.env.example`）
- 本机访问 HTTP API：`http://localhost:3210` 或 `http://127.0.0.1:3210`
- 本机访问 WSS RPC：`wss://localhost:3211/ws/browser`
- 控制台静态资源：`server/public/`

如果 `server/public/` 不存在，服务端会尝试自动执行 `server/frontend` 的构建。

### 6. 启动客户端

客户端负责启动项目专用 Chrome、注入浏览器侧配置，并拉起本地浏览器辅助同步：

```bash
cd client && npm start && cd ..
```

这里的 `npm start` 实际执行的是 `node start.js`。

如果只想单独运行浏览器辅助同步器，也可以执行：

```bash
cd client && npm run sync && cd ..
```

如果你是把本地端交付到另一台机器，优先使用交付目录：

```bash
cd deploy/local-client-package/client && npm install && npm start
```

对应的扩展加载目录是 `deploy/local-client-package/chrome_extension/dist/`。

### 7. 加载浏览器侧

**闲鱼聊天 Chrome 扩展**

使用前必须先执行上一步构建，生成 `chrome_extension/dist/`。Chrome 扩展页面加载的是构建产物目录，不是源码目录。

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 指向 `chrome_extension/dist`
5. 打开 `https://www.goofish.com/im`

**千牛订单 Tampermonkey 脚本**

1. 在 Tampermonkey 中导入 `qianniu_capture/qianniu_batch_consign.js`
2. 打开 `https://myseller.taobao.com/home.htm/batch-consign`

### 8. 打开控制台

访问 `http://localhost:3210`。

## API 摘要

以下接口来自 [`server/index.ts`](server/index.ts) 的当前实现：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/messages/ingest` | 批量写入聊天快照 |
| `GET` | `/api/sessions` | 查询会话列表 |
| `GET` | `/api/sessions/:chatKey/messages` | 查询单会话消息 |
| `GET` | `/api/settings` | 读取运行时设置 |
| `PATCH` | `/api/settings` | 更新自动回复 / 巡逻开关 / 初始遍历数量 |
| `POST` | `/api/initial-crawl` | 请求浏览器重新做首轮会话遍历 |
| `GET` | `/api/orders` | 查询订单列表 |
| `GET` | `/api/orders/runtime` | 查询千牛侧运行状态 |
| `POST` | `/api/orders/full-scan` | 请求千牛全量扫描 |
| `POST` | `/api/orders/sync-now` | 请求千牛立即同步 |
| `POST` | `/api/browser/heartbeat` | 浏览器脚本上报心跳 |
| `POST` | `/api/outgoing-messages` | 手工或 AI 入队待发送消息 |
| `GET` | `/api/outgoing-messages` | 查询待发送 / 已发送消息 |
| `POST` | `/api/outgoing-messages/claim` | 浏览器脚本领取待发送消息 |
| `PATCH` | `/api/outgoing-messages/:id` | 浏览器脚本回写发送结果 |

## 数据、日志与构建产物

| 路径 | 说明 |
|---|---|
| `server/data.db` | SQLite 数据库 |
| `server/public/` | React 控制台构建产物 |
| `server/public/media-cache/` | 图片缓存目录 |
| `server/.localhost-wss/` | 自动生成的本地 TLS 证书 |
| `server/*.log` | 服务端日志 |
| `client/*.log` | 旧客户端链路日志 |
| `client/.browser-media-cache/` | 本地浏览器图片缓存与 manifest |
| `deploy/local-client-package/client/.browser-media-cache/` | 交付包运行时的本地图片缓存 |

## 开发阅读顺序

1. [`server/index.ts`](server/index.ts)：后端入口、HTTP API、WSS RPC、启动流程
2. [`server/db.ts`](server/db.ts)：SQLite 结构、入库逻辑、运行时状态管理
3. [`server/auto_reply_worker.ts`](server/auto_reply_worker.ts)：自动回复处理循环
4. [`server/frontend/src/App.tsx`](server/frontend/src/App.tsx)：控制台入口
5. `chrome_extension/src/content_script/`：聊天采集、心跳、发送、WSS RPC
6. [`qianniu_capture/qianniu_batch_consign.ts`](qianniu_capture/qianniu_batch_consign.ts)：订单采集与同步

## 跨网络部署

默认情况下，服务端会监听 `0.0.0.0`，并自动生成仅覆盖 `localhost` 与 `127.0.0.1` 的自签证书。如果浏览器脚本不在本机，需要额外处理证书 SAN、浏览器信任链和回连地址。

服务端至少需要关注：

- `BROWSER_WSS_CERT_SAN`
- `BROWSER_WSS_CERT_PATH`
- `BROWSER_WSS_KEY_PATH`
- `CORS_ALLOWED_ORIGINS`
- `BROWSER_MEDIA_ORIGIN`

浏览器脚本侧当前统一支持通过页面 `localStorage` 的 `xm_server_wss_url` 覆写 WSS 地址。

如果你使用 `client/start.js`（或直接调试 `client/start.ts`），并设置了 `SERVER_HOST`，启动器会自动把该地址注入到闲鱼页和千牛页。

如果你是手工部署，需要在对应页面各自执行一次：

```js
localStorage.setItem('xm_server_wss_url', 'wss://192.168.1.100:3211/ws/browser');
```

注意：`localStorage` 按页面来源隔离，`goofish.com` 和 `myseller.taobao.com` 需要分别设置。

服务端当前没有认证层，不应直接暴露到公网。

## 常用命令

| 命令 | 说明 |
|---|---|
| `cd server && npm start && cd ..` | 启动纯服务端链路 |
| `cd server && npm run dev && cd ..` | watch 模式启动纯服务端链路 |
| `cd server/frontend && npm run dev && cd ../..` | 本地调试 React 控制台 |
| `cd server/frontend && npm run build && cd ../..` | 构建控制台到 `server/public/` |
| `cd client && npm start && cd ..` | 启动本地 Chrome 客户端 |
| `cd client && npm run sync && cd ..` | 单独运行客户端辅助同步器 |
| `cd chrome_extension && npm run dev && cd ..` | watch 模式构建扩展 |
| `cd chrome_extension && npm run build && cd ..` | 生产构建扩展 |
| `node server/auto_reply_worker.ts --once` | 单轮执行自动回复 |
| `node server/auto_reply_worker.ts --dry-run --once` | 单轮 dry-run 自动回复 |

## 已知问题

- `xianyu_capture/` 仍属于旧链路目录；当前浏览器侧主链路以 `client/ + chrome_extension/ + qianniu_capture/` 为准
- 跨网络部署依赖自签证书信任、CORS 和两侧页面的 WSS 覆写地址，落地前需要逐项确认

## 备注

- 如果你是从旧版本 README 迁移过来，优先以“相对之前版本的修改”为准
- 如果 README 与实际代码行为不一致，以 `server/`、`client/`、`deploy/local-client-package/` 当前实现为准

## 许可证

本项目基于 [Apache-2.0](LICENSE) 开源。
