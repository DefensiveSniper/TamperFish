# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TamperFish

闲鱼聊天聚合管理台：Chrome 扩展采集闲鱼 IM 消息 + 本地 Node/SQLite 存储 + React 控制台 + 浏览器回填发送 + LLM 自动回复。另有千牛代发订单采集脚本，可将订单与会话关联。

**架构已拆分为独立的 client/ 和 server/ 两端**，支持远程部署：server 运行 API+数据库，client 运行 Chrome+sync，通过 `SERVER_URL` 环境变量连接。

## Build & Run Commands

| 场景 | 命令 |
|---|---|
| 安装服务端依赖 | `cd server && npm ci` |
| 安装客户端依赖 | `cd client && npm install` |
| 安装前端依赖 | `cd frontend && npm ci` |
| 安装扩展依赖 | `cd chrome_extension && npm ci` |
| **启动服务端** | `cd server && npm start`（API + WSS + worker） |
| **启动客户端** | `cd client && npm start`（Chrome + sync） |
| 服务端开发（watch） | `cd server && npm run dev` |
| 前端开发（HMR） | `cd frontend && npm run dev` → http://localhost:5173 |
| 构建前端 | `cd frontend && npm run build`（输出到 `server/public/`） |
| **构建全部（扩展+前端）** | `npm run build`（根目录） |
| 仅构建 Chrome 扩展 | `npm run build:extension`（根目录）或 `cd chrome_extension && npm run build` |
| 扩展开发（content_script watch） | `cd chrome_extension && npm run dev` |
| 单独启动 Worker | `cd server && npm run worker` |
| Worker 干跑（不调 LLM） | `cd server && npm run worker:dry:once` |
| CDP 同步守护（单独） | `cd client && npm run sync` |

注意：本项目没有 test 命令，无单元测试。前端使用 TypeScript strict 模式，可通过 `cd frontend && npx tsc --noEmit` 进行类型检查。

## Ports

| 服务 | 端口 |
|---|---|
| API + 静态控制台 | `127.0.0.1:3210` |
| Chrome 远程调试 (CDP) | `localhost:18800` |
| 浏览器脚本 WSS | `wss://localhost:3211/ws/browser` |
| 前端 Vite dev | `localhost:5173`（代理 `/api` → 3210） |

## Architecture

```
【client 端（用户本机）】
Chrome(:18800 CDP) ──► client/sync.js ──► POST /api/messages/ingest
浏览器(goofish.com) ──Chrome扩展──► WSS :3211 ──► index.js ──► db.js (SQLite)
                    ◄─────────────────────────── outgoing_messages (回填队列)

【server 端（可远程）】
index.js ──► db.js (SQLite)
auto_reply_worker ──► ai.js ──► outgoing_messages
React SPA :5173(dev) / :3210(prod) ◄──► /api/*
```

**双路采集**：Chrome 扩展通过 WSS 推送 + client/sync.js 通过 CDP 轮询 localStorage，两路均写入 SQLite，用 `UNIQUE(chat_key, msg_hash)` 去重。

**发送回路**：auto_reply_worker 消费 outbox 事件 → 调 ai.js → 写 outgoing_messages(pending) → 扩展每 1.5s 轮询 claim → 在浏览器 DOM 中定位会话并发送 → 回报 sent/failed。

**远程部署**：`cd client && SERVER_URL=http://<remote>:3210 SERVER_HOST=<remote> npm start`，客户端通过 CDP 将远程 WSS 地址注入浏览器 localStorage。

### Key Server Files

- `server/start.js` — 服务端启动器：仅启动 index.js（API + WSS + worker）
- `server/index.js` — Express API 路由 + WSS 端点 + 静态文件服务
- `server/db.js` — **所有** SQLite 操作集中于此（schema、migration、CRUD），不在其他文件写 SQL
- `server/auto_reply_worker.js` — outbox 消费 + LLM 调用，支持 `--dry-run`、`--once` 参数
- `server/ai.js` — LLM 封装（DeepSeek/OpenAI），本地覆盖用 `ai.local.js`

### Key Client Files

- `client/start.js` — 客户端启动器：Chrome 生命周期管理 + watchdog + CDP WSS 注入 + sync.js
- `client/sync.js` — CDP 守护进程，每 5s 读取 `xm_chat_history` 并 POST 到 `/api/messages/ingest`

### Chrome Extension (MV3)

`chrome_extension/` 是独立的 Manifest V3 工程，与油猴脚本功能等价但以 Chrome 扩展形式分发。

- **三个入口独立构建**（ENTRY 环境变量切换，均输出为 IIFE 到 `chrome_extension/dist/`）：
  - `content_script` — 运行在 `world: "MAIN"`，**不可使用 `chrome.*` API**；复用了与油猴脚本相同的采集/发送逻辑
  - `background` — Service Worker，处理扩展图标点击、侧边栏控制（`sidePanel` API）
  - `popup` — 工具栏弹窗
- **面板模式**：`localStorage._tamperfish_panel_mode`，值为 `'embedded'` 时启用内嵌浮窗（与油猴脚本体验一致），否则使用 Chrome 侧边栏（`side_panel.html`）。
- **静态资源**：`chrome_extension/public/` 含 `manifest.json`、`popup.html`、`side_panel.html`、图标；构建不清空此目录。
- **CSS 选择器**：`config.ts` 中 `selectors` 字段的类名来自闲鱼 IM 页面，迭代后可能失效，需同步更新。

### Frontend Conventions

- **React 18 + TypeScript strict + Vite 8**，输出到 `server/public/`
- 全局状态用 `AppContext.tsx`（useReducer），**不用 Redux**
- 所有 TypeScript 接口定义在 `frontend/src/types/api.ts`
- API 调用统一经 `frontend/src/services/` 封装，组件内不直接 `fetch`
- 组件按功能分目录：`Header/`、`Sidebar/`、`ChatPanel/`、`OrdersDrawer/`、`Toast/`
- `usePolling(3000)` 轮询 sessions/orders/当前会话
- 移动端适配：`useIsMobile()`、`useMobileNav()`、`useViewportHeight()`

### Database

核心表：`sessions`、`messages`、`outbox`、`outgoing_messages`、`orders`、`app_settings`、`qianniu_runtime`。

订单与会话的匹配逻辑依赖 `buyer_user_id + product_id` 联合键，改动 order 查询时注意保持此逻辑。

## Important Gotchas

- Chrome profile 在 `.chrome-xianyu-profile/`，`client/start.js` 清理 Cache/GPUCache 但**保留 Sessions 目录**
- `server/public/` 是 Vite 构建输出，不要手动删除
- `client/sync.js` 必须先有 CDP 端口 18800，单独调试需手动启动 Chrome with `--remote-debugging-port=18800`
- LLM 配置：环境变量 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`，或 `server/ai.local.js` 覆盖
- 客户端代理配置：`client/.chrome-proxy.local.json`（已加入 .gitignore）

## Agent 协作硬性规定（必须遵守）

本项目由多个 agent 轮流/协同开发。

### 日志流程
1. **开始工作前**：读取 `agent_logs/LATEST.md`（不要翻旧日志）
2. **每次交付后**必须写入两份文件：
   - `agent_logs/YYYY-MM-DD_HHMM_<agentName>.md`（归档）
   - `agent_logs/LATEST.md`（覆盖为本次内容）
3. 日志必须包含：**需求**、**你做了什么**、**如何验证**、**影响面**、**下一步**

### 禁止事项
- 禁止只改代码不写日志
- 禁止跨目录改动不在日志里说明

### Chrome 扩展版本规则
修改 `chrome_extension/` 内容时，如涉及功能变更，**必须同步更新** `chrome_extension/public/manifest.json` 中的 `version` 字段。
