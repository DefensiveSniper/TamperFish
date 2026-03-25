# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TamperFish

闲鱼聊天聚合管理台：Tampermonkey 脚本采集闲鱼 IM 消息 + 本地 Node/SQLite 存储 + React 控制台 + 浏览器回填发送 + LLM 自动回复。另有千牛代发订单采集脚本，可将订单与会话关联。

## Build & Run Commands

| 场景 | 命令 |
|---|---|
| 安装后端依赖 | `cd server && npm ci` |
| 安装前端依赖 | `cd frontend && npm ci` |
| **全栈启动（生产）** | `cd server && npm start`（自动启动 Chrome + API + sync + worker） |
| 后端开发（watch） | `cd server && npm run dev` |
| 前端开发（HMR） | `cd frontend && npm run dev` → http://localhost:5173 |
| 构建前端 | `cd frontend && npm run build`（输出到 `server/public/`） |
| 单独启动 Worker | `cd server && npm run worker` |
| Worker 干跑（不调 LLM） | `cd server && npm run worker:dry:once` |
| CDP 同步守护 | `cd server && npm run sync` |

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
浏览器(goofish.com) ──油猴脚本──► WSS :3211 ──► index.js ──► db.js (SQLite)
                   ◄──────────────────────────── outgoing_messages (回填队列)
Chrome CDP :18800 ──► sync.js ──────────────────► db.js
auto_reply_worker ──► ai.js ──► outgoing_messages
React SPA :5173(dev) / :3210(prod) ◄──► /api/*
```

**双路采集**：油猴脚本通过 WSS 推送 + sync.js 通过 CDP 轮询 localStorage，两路均写入 SQLite，用 `UNIQUE(chat_key, msg_hash)` 去重。

**发送回路**：auto_reply_worker 消费 outbox 事件 → 调 ai.js → 写 outgoing_messages(pending) → 油猴脚本每 1.5s 轮询 claim → 在浏览器 DOM 中定位会话并发送 → 回报 sent/failed。

### Key Server Files

- `server/start.js` — 统一启动器：管理 Chrome 进程、API、sync、worker 子进程
- `server/index.js` — Express API 路由 + WSS 端点 + 静态文件服务
- `server/db.js` — **所有** SQLite 操作集中于此（schema、migration、CRUD），不在其他文件写 SQL
- `server/sync.js` — CDP 守护进程，每 5s 读取 `xm_chat_history` 并 POST 到 `/api/messages/ingest`
- `server/auto_reply_worker.js` — outbox 消费 + LLM 调用，支持 `--dry-run`、`--once` 参数
- `server/ai.js` — LLM 封装（DeepSeek/OpenAI），本地覆盖用 `ai.local.js`

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

- Chrome profile 在 `.chrome-xianyu-profile/`，start.js 清理 Cache/GPUCache 但**保留 Sessions 目录**
- `server/public/` 是 Vite 构建输出，不要手动删除
- `sync.js` 必须先有 CDP 端口 18800，单独调试需手动启动 Chrome with `--remote-debugging-port=18800`
- LLM 配置：环境变量 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`，或 `server/ai.local.js` 覆盖

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

### 油猴脚本版本规则
修改 `xianyu_capture/xianyu_monitor.js` 时，**必须同步更新**四处：
1. `@name` 版本后缀
2. `@version` 字段
3. 初始化日志版本文案
4. 面板标题版本文案
