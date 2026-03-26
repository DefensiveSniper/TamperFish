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
- 默认启动入口已经切换到当前 `.ts` 源码入口，`npm start` / `npm run worker:*` 可直接使用

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
- `client/start.ts`、`client/sync.ts` 会加载 `client/.env`

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

如果只想单独运行浏览器辅助同步器，也可以执行：

```bash
cd client && npm run sync && cd ..
```

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

如果你使用 `client/start.ts`，并设置了 `SERVER_HOST`，启动器会自动把该地址注入到闲鱼页和千牛页。

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

## 许可证

本项目基于 [Apache-2.0](LICENSE) 开源。
