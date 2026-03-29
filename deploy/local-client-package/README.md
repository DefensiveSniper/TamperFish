# 本地端交付包

这个目录是给本地端使用的最小交付包，包含两部分：

- `client/`：本地启动器，用来启动项目专用 Chrome、连接服务端、做本地同步
- `chrome_extension/dist/`：已经构建好的 Chrome 扩展产物，用来采集闲鱼聊天和执行发送动作

注意：`client/` 不是只有 `start.ts` 和 `sync.ts` 两个入口文件，它还依赖同目录下的辅助源码，以及上一级目录的 `load_env.ts`。当前交付包的实际启动入口是 `start.js`，因此分发时必须整体保留当前目录结构，不能只单独拷贝入口文件。

## 目录说明

- `client/`
- `chrome_extension/dist/`
- `load_env.ts`

其中 `client/` 目录内至少应包含：

- `start.ts`
- `start.js`
- `sync.ts`
- `browser_bridge_actions.ts`
- `chrome_tls.ts`
- `media_cache.ts`
- `.env.example`
- `package.json`

## 本地端运行要求

- macOS 或 Windows
- Node.js 18+
- Chrome 浏览器

建议直接使用 Node.js 20 LTS。

## 一、本地端如何启动

进入 `client/` 目录，先准备配置文件：

```bash
cp .env.example .env
```

最少需要改这几项：

```env
SERVER_URL=http://127.0.0.1:3210
CLIENT_ID=shop-a-client-1
ACCOUNT_ID=shop-a
CLIENT_NAME=店铺A-本机
```

说明：

- `SERVER_URL`：服务端地址。如果服务端也部署在这台电脑上，保持 `http://127.0.0.1:3210` 即可
- `CLIENT_ID`：当前这台机器的唯一标识，不能和别的机器重复
- `ACCOUNT_ID`：同一个店铺的多台机器填同一个值
- `CLIENT_NAME`：控制台里显示的机器名称

注意：不要再使用 `legacy-client-1` 作为 `CLIENT_ID`。当前 server 启动时会主动清理这个历史默认 client，继续使用它会导致 client 上报 `/api/messages/ingest` 时持续返回 `401 unauthorized`。

启动命令：

```bash
cd client
npm start
```

如果只想运行同步器，也可以：

```bash
cd client
npm run sync
```

## 二、浏览器如何安装插件

扩展已经提前构建好了，直接加载 `chrome_extension/dist/` 即可。

安装步骤：

1. 打开 Chrome
2. 访问 `chrome://extensions`
3. 打开右上角“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择这个目录下的 `chrome_extension/dist/`
6. 安装完成后，打开 `https://www.goofish.com/im`

注意：

- 加载的是 `dist/`，不是 `chrome_extension/` 源码目录
- 如果扩展更新了，需要在扩展页点一次刷新

## 三、推荐启动顺序

如果服务端也在这台电脑上，推荐顺序：

1. 先启动服务端
2. 再启动 `client`
3. 再打开 Chrome 扩展页面确认扩展已加载
4. 最后打开闲鱼聊天页 `https://www.goofish.com/im`

## 四、你稍后在这台电脑部署服务端时要注意

服务端目录仍然使用仓库里的 `server/`。

服务端启动：

```bash
cd server
cp .env.example .env
npm ci
npm start
```

默认访问地址：

- 控制台：`http://127.0.0.1:3210`
- 浏览器脚本 WSS：`wss://127.0.0.1:3211/ws/browser`

## 五、当前这台电脑上的一个已确认前置条件

当前仓库里的 `server/frontend` 使用的 Vite 版本要求 Node.js `20.19+` 或 `22.12+`。

这台电脑当前是 Node.js `20.11.1`，所以：

- `chrome_extension` 可以正常构建
- `client` 可以正常安装依赖
- `server/frontend` 当前不能在这台机器上完成构建

如果你稍后要在这台电脑完整部署服务端，建议先升级 Node.js 到以下任一版本：

- Node.js 20.19+
- Node.js 22.12+

升级后再执行：

```bash
cd server/frontend
npm ci
npm run build
```

构建成功后会生成服务端控制台静态资源。

## 六、交付目录说明

当前交付目录：

- `deploy/local-client-package/`

你可以直接把这个目录整体拷走，在目标机器上按上面的步骤运行。