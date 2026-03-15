# 闲鱼聊天记录聚合服务 (`TamperFish`)

[English](README.md) | [简体中文](README.zh-CN.md)

这是一个围绕闲鱼 PC Web 消息链路和千牛待发货订单链路做本地聚合、人工接管和自动回复的工具集。当前仓库已经打通了 6 条链路：

1. 油猴脚本在 `goofish.com/im` 页面采集会话、消息和会话侧元数据
2. `sync.js` 通过 Chrome CDP 定时读取浏览器本地缓存并补采闲鱼消息
3. 千牛油猴脚本在 `myseller.taobao.com/home.htm/batch-consign` 页面采集待发货订单
4. 本地 API + SQLite 聚合会话、消息、订单，并在 `3210` 提供管理控制台
5. 待发消息进入 `outgoing_messages` 队列，由浏览器脚本自动回填发送
6. 千牛订单按 `buyer_user_id + product_id` 与闲鱼会话自动关联，并展示到控制台和聊天头部

## 核心能力

- 会话聚合：前台油猴脚本与后台 CDP 双路采集，消息落地到 SQLite
- 千牛订单采集：解析 `batch-consign` 订单卡片，落库订单号、买家、商品、金额、数量和收件信息
- 订单关联：按 `buyer_user_id + product_id` 将千牛订单精准关联到闲鱼会话
- 本地控制台：在 `http://127.0.0.1:3210` 查看会话、消息、待发队列
- 订单控制台：订单抽屉支持查看脚本运行态、立即同步当前页和手动全量扫描
- 人工回复：UI 右侧输入框会把消息压入 `pending` 队列，再由浏览器发送
- AI 开关：UI 顶栏支持全局开启/关闭 AI 自动回复，便于人工接管
- 巡逻开关：UI 顶栏支持远程开启 / 关闭油猴后台巡逻；不影响精准发送与按需补水
- 启动初始化：项目启动后会先限量初始化同步会话历史，默认拉前 `30` 个会话
- 未读监听：初始化完成后默认关闭自动巡逻，改为根据左侧未读角标增量同步新消息
- 精准发送：浏览器脚本会主动 claim 待发任务，并优先按 `session_id` 定位目标会话后发送
- 自动回复：Worker 消费 `outbox.new_messages`，生成回复后写入 `outgoing_messages`
- 项目专用 Chrome：`npm start` 会自动拉起带 `18800` 调试端口的项目 Chrome
- Chrome 代理：支持通过本地配置文件或环境变量给项目 Chrome 单独配置代理
- 日志落盘：启动链路、Chrome、`sync.js`、API 和内置 worker 都会写入日志文件

## 目录结构

```text
goofishAggregation/
├── qianniu_capture/
│   └── qianniu_batch_consign.js # Tampermonkey 脚本：千牛待发货订单采集
├── xianyu_capture/
│   └── xianyu_monitor.js        # Tampermonkey 脚本（当前面板版本 4.0）
├── server/
│   ├── package.json            # Node 依赖与脚本
│   ├── start.js                # 统一启动器：Chrome + API + sync.js
│   ├── index.js                # Express API + 本地 UI
│   ├── db.js                   # SQLite 数据层
│   ├── sync.js                 # CDP 同步守护进程
│   ├── auto_reply_worker.js    # 自动回复 worker
│   ├── ai.js                   # LLM 调用封装
│   ├── public/                 # 3210 控制台静态资源
│   ├── data.db                 # [自动生成] SQLite 数据库
│   ├── server.log              # [自动生成] 启动器 / Chrome / sync 综合日志
│   └── server3210.log          # [自动生成] API 与内置 worker 日志
├── integrations/
│   └── qianniu/                # 预留扩展
└── agent_logs/                 # 协作日志
```

## 环境要求

- Node.js 20+（当前机器实际使用 Node 22）
- 桌面版 Google Chrome
- Tampermonkey 扩展
- 已登录的闲鱼网页版 `https://www.goofish.com/im`

## 安装依赖

推荐使用锁文件安装：

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm ci
```

如果你明确接受重新解析依赖，也可以用：

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm install
```

## 启动方式

### 1. 一键启动整套链路

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm start
```

默认会做这些事：

- 使用仓库下的项目专用 Chrome 目录 `.chrome-xianyu-profile`
- 启动前自动清理项目 Chrome 的瞬态缓存与残留锁文件，但保留 `Sessions`，以便恢复上次会话和 session cookie
- 如果 profile 中存在上次会话数据，则使用 Chrome 会话恢复模式启动，不重复注入初始 URL
- 如果是首次启动或当前 profile 没有可恢复会话，则自动打开 `https://www.goofish.com/im` 与 `https://myseller.taobao.com/home.htm/batch-consign`
- 为项目 Chrome 增加 `--allow-insecure-localhost`，允许脚本连接本地自签 `wss://localhost`
- 为 Chrome 开启 `18800` 调试端口
- 启动 API 服务 `127.0.0.1:3210`
- 启动浏览器脚本专用 `wss://localhost:3211/ws/browser`
- 启动 `sync.js`
- 启动内置自动回复 worker
- 监控 `18800`，如果项目 Chrome 被关掉会自动拉起

如果要排查代理是否导致项目 Chrome 启动异常，可以临时这样启动：

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
CHROME_PROXY_DISABLED=1 npm start
```

如果你明确要保留当前缓存现场、不执行启动前清理，也可以临时关闭：

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
CHROME_CLEAR_TRANSIENT_DATA_ON_START=0 npm start
```

### 2. 开发模式

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm run dev
```

这会用 `node --watch` 启动 API 入口，适合改后端代码时使用。

### 3. 单独运行 worker

仅在调试时使用：

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm run worker
npm run worker:dry
npm run worker:once
npm run worker:dry:once
```

注意：

- `npm start` 已经会启动内置 worker
- 不要在 `npm start` 已运行的同时再额外跑 `npm run worker`，否则会出现多个 worker 并发消费同一批 `outbox` 事件的风险

## 浏览器端配置

### 1. 安装并启用 Tampermonkey

在 Chrome 中安装 Tampermonkey 扩展。

### 2. 导入油猴脚本

导入并启用：

- [xianyu_capture/xianyu_monitor.js](xianyu_capture/xianyu_monitor.js)
- [qianniu_capture/qianniu_batch_consign.js](qianniu_capture/qianniu_batch_consign.js)

当前闲鱼脚本面板版本为 `4.0`，千牛订单脚本版本为 `1.4`。每次脚本更新后，请确认 Tampermonkey 中版本文案也同步更新。
千牛订单脚本首次导入后，请允许脚本访问 `trade.taobao.com`，用于抓取 `tradeSnap` 页面中的商品 ID。

当前脚本与本地服务的控制链路不再依赖高频 HTTP 轮询，而是走单条长连接：

- `wss://localhost:3211/ws/browser`

项目启动时会自动为 localhost 生成一套本地开发证书，并让项目 Chrome 接受 localhost 自签证书。

### 3. 登录闲鱼 / 千牛网页版

在项目 Chrome 中完成一次登录后，后续启动会优先恢复上次会话：

- [goofish.com/im](https://www.goofish.com/im)
- [myseller.taobao.com/home.htm/batch-consign](https://myseller.taobao.com/home.htm/batch-consign)

说明：

- 闲鱼消息脚本运行在 `goofish.com/im`
- 千牛订单脚本运行在 `batch-consign`
- 千牛脚本会按 `orderId` 缓存已解密的买家信息；成功解密过的订单后续不再重复点击“解密”
- 首次启动或使用全新 profile 时，启动器会自动打开闲鱼和千牛入口页
- 如果当前 profile 中已有上次会话，启动器会恢复原有标签页和 session cookie，通常不需要手动重新打开千牛页面

脚本默认会先做一轮启动初始化：限量遍历前 `30` 个会话并尽量拉回历史记录，随后自动关闭常驻巡逻。

初始化完成后：

- 当前打开的会话会继续做轻量同步
- 左侧带未读角标的会话会被按需打开并增量同步
- 全量遍历只保留给手动开启巡逻和精准发送 fallback 使用

## 3210 控制台说明

打开：

- [http://127.0.0.1:3210](http://127.0.0.1:3210)

当前 UI 支持：

- 左侧会话列表增量刷新，减少轮询闪烁
- 右侧消息区主动刷新，当前会话有新消息时无需重新点左侧会话
- 顶栏订单抽屉：查看千牛待发货订单、关联状态与脚本运行态，并支持立即同步当前页与手动全量扫描
- 顶栏 AI 开关：全局开启 / 关闭自动回复
- 顶栏巡逻开关：远程控制油猴后台巡逻，并显示脚本同步状态
- 右侧人工回复输入框：消息先入 `pending` 队列，再由浏览器发送
- 待发队列面板：区分 `AI` / `人工` 来源
- 会话头部订单摘要：已精准关联的订单会显示在对应聊天顶部

## 环境变量与本地配置

### AI / API 相关

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `AUTO_REPLY_ENABLED`
- `AUTO_REPLY_INTERVAL_MS`

当前行为说明：

- `AUTO_REPLY_ENABLED=0` 会把运行时 AI 开关初始化为关闭
- 内置 worker 仍然会启动，但会跳过自动回复生成

### Chrome / 启动器相关

- `PORT`：本地 API 端口，默认 `3210`
- `BROWSER_WSS_PORT`：浏览器脚本专用 WSS 端口，默认 `3211`
- `BROWSER_WSS_PATH`：浏览器脚本专用 WSS 路径，默认 `/ws/browser`
- `BROWSER_WSS_CERT_PATH`：可选，自定义 localhost WSS 证书路径
- `BROWSER_WSS_KEY_PATH`：可选，自定义 localhost WSS 私钥路径
- `CDP_PORT`：Chrome DevTools 调试端口，默认 `18800`
- `SYNC_INTERVAL`：`sync.js` 轮询间隔，默认 `5000`
- `CHROME_PROFILE_NAME`：日志里显示的 profile 名，默认 `xianyu`
- `CHROME_PROFILE_DIRECTORY`：项目 Chrome 目录中的 profile 目录名，默认 `Default`
- `CHROME_USER_DATA_DIR`：项目 Chrome 用户数据目录，默认仓库下 `.chrome-xianyu-profile`
- `GOOFISH_URL`：首次启动时默认打开的闲鱼页面，默认 `https://www.goofish.com/im`
- `QIANNIU_URL`：首次启动时默认打开的千牛页面，默认 `https://myseller.taobao.com/home.htm/batch-consign`
- `CHROME_MONITOR_INTERVAL_MS`：Chrome watchdog 检测间隔，默认 `3000`
- `CHROME_CLEAR_TRANSIENT_DATA_ON_START`：启动前是否清理项目 Chrome 瞬态缓存，默认开启；保留 `Sessions` 用于恢复上次会话，设为 `0` 可关闭
- `CHROME_START_TIMEOUT_MS`：等待 Chrome 打开 CDP 端口的超时时间，默认 `15000`

### Chrome 代理相关

- `CHROME_PROXY_SERVER`
- `CHROME_PROXY_USERNAME`
- `CHROME_PROXY_PASSWORD`
- `CHROME_PROXY_BYPASS_LIST`
- `CHROME_PROXY_CONFIG_PATH`

默认会优先读取本地文件：

- [server/.chrome-proxy.local.json](server/.chrome-proxy.local.json)

示例：

```json
{
  "proxyServer": "http://127.0.0.1:7890",
  "proxyUsername": "",
  "proxyPassword": "",
  "proxyBypassList": "localhost;127.0.0.1;::1"
}
```

说明：

- 代理只作用于项目启动器拉起的那一个项目 Chrome，不影响你系统里其他普通 Chrome
- 如果代理带账号密码，启动器会自动生成本地认证扩展 `server/.chrome-proxy-extension/`
- 这两个本地文件/目录都已被 `.gitignore` 忽略

### 自定义 Chrome 目录的注意事项

如果你要自定义 `CHROME_USER_DATA_DIR`：

- 对一个全新的空目录，最好同时显式设置 `CHROME_PROFILE_DIRECTORY`
- 如果只传 `CHROME_USER_DATA_DIR` 而不给 `CHROME_PROFILE_DIRECTORY`，当前启动器会尝试从该目录的 `Local State` 解析 profile；空目录下没有这个文件，启动会失败

## 日志文件

默认日志位置：

- [server/server.log](server/server.log)
  - 启动器日志
  - Chrome 输出
  - `sync.js` 输出
- [server/server3210.log](server/server3210.log)
  - API 服务日志
  - 内置 worker 日志

## 数据库与队列

核心表：

- `sessions`：会话主表
- `messages`：聊天消息
- `outbox`：内部事件总线（`new_session` / `new_messages`）
- `outgoing_messages`：待发送消息队列（`pending / sending / sent / failed`）
- `app_settings`：运行时设置，例如 AI 开关

当前发送链路是：

1. 新消息进入 `outbox`
2. worker 生成回复，写入 `outgoing_messages.pending`
3. 浏览器 sender loop 原子 claim 一条待发任务
4. 优先按 `session_id` 精准定位目标会话；定位失败时再做限次 fallback 遍历补水
5. 浏览器自动填写并发送
6. 发送后立即补抓当前会话，保证新消息及时写回本地缓存
7. API 回写状态为 `sent` 或 `failed`

## 常见问题

### 1. `3210` 有数据但右侧消息区不更新

刷新一次浏览器页面，确保拿到最新前端脚本。当前版本已经支持主动刷新当前会话。

### 2. 数据库里出现“只有买家名、没有消息”的空会话

后端已经在 `ingest()` 层拦截空快照，不会再把这种空壳写进 `sessions`。如果旧数据还在，可以手动清理数据库中的历史脏记录。

### 3. 项目 Chrome 被关掉了怎么办

如果是通过 `npm start` 启动的，watchdog 会监控 `18800`，发现关闭后会自动重新拉起项目 Chrome。

### 4. 切换代理怎么做

修改：

- [server/.chrome-proxy.local.json](server/.chrome-proxy.local.json)

然后重启：

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm start
```

如果要临时绕过代理做故障排查，可以直接用：

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
CHROME_PROXY_DISABLED=1 npm start
```

## 当前已知限制

- 当前启动器只支持一个项目 Chrome 实例，还不能直接在同一个 `3210` 控制台里安全聚合多个卖家账号
- `server/ai.js` 目前仍然保留了默认 API key fallback，生产环境不建议继续沿用
- `outbox` 事件当前是“读后处理、处理完再标记”，如果同时运行多个 worker，存在重复消费风险
- 当前精准发送仍依赖闲鱼页面内可读取的 `sessionInfo.sessionId`；如果页面结构变化，会退回到限次 fallback 遍历补水

## 下一步开发计划

以下内容尚未实现，作为后续开发项保留：

### 0. 方案文档（持续演进）

关于多账号 / 商店并发聚合、多 worker 调度与精准发送的持续演进方案，统一维护在：

- [docs/multi-shop-aggregation-evolution.md](docs/multi-shop-aggregation-evolution.md)

说明：

- README 这里只保留入口、范围与状态，不重复展开完整设计内容
- 后续若方案有新增决策、假设修订或 TODO 调整，优先更新该文档，再视情况同步 README 摘要

### 1. 多开 Chrome 与多代理

目标：

- 支持同时拉起多个项目 Chrome 实例
- 每个实例可单独配置 `userDataDir`、`profileDirectory`、`cdpPort` 和代理
- 同一个 `3210` 控制台能够汇总展示多个实例的数据

计划改造范围：

- `server/start.js`
  - 改成实例列表驱动，而不是当前单实例模式
  - 每个实例单独维护 watchdog、Chrome 进程和代理配置
- `server/sync.js`
  - 改成“一实例一同步进程”
  - 上报数据时带上 `instanceId`
- `xianyu_capture/xianyu_monitor.js`
  - 会话快照、待发消息匹配和发送状态回写都带上实例标识
- `server/db.js`
  - 为 `sessions`、`messages`、`outbox`、`outgoing_messages` 增加 `instance_id` / `account_id` 维度
  - 避免不同 Chrome 或不同卖家账号之间的 `chat_key` 冲突
- `server/index.js` 与 `server/public/`
  - 在 UI 中展示会话来源实例
  - 增加按实例筛选或切换能力

当前状态说明：

- 现在只是在启动层面具备“未来可扩展成多实例”的基础
- 如果当前直接强行多开多个 Chrome 并接入同一个数据库，会有会话串线、待发消息串发和 UI 混淆风险
