// @ts-nocheck
'use strict';

const path = require('path');
const { loadOptionalEnvFiles } = require('../load_env.ts');

loadOptionalEnvFiles([
  path.join(__dirname, '.env'),
]);

const express = require('express');
const https = require('https');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const db = require('./db.ts');
const { startAutoReplyWorker } = require('./auto_reply_worker.ts');
const {
  cacheRemoteImages,
  localizeMessages,
  localizeSessions,
  serveCachedMediaRequest,
} = require('./media_cache.ts');

const app = express();
const PORT = process.env.PORT || 3210;
const SERVER_BIND_HOST = process.env.SERVER_BIND_HOST || '0.0.0.0';
const DEFAULT_BROWSER_WSS_PORT = Number(process.env.BROWSER_WSS_PORT || (Number(PORT) + 1));
const DEFAULT_BROWSER_WSS_PATH = process.env.BROWSER_WSS_PATH || '/ws/browser';
const DEFAULT_BROWSER_WSS_CERT_DIR = path.join(__dirname, '.localhost-wss');
const BROWSER_MEDIA_ORIGIN_EXPLICIT = process.env.BROWSER_MEDIA_ORIGIN || '';

/**
 * 获取媒体缓存资源的公开访问源。
 * 优先使用环境变量显式设置；未设置时，尝试从 HTTP 请求的 Host 头推导；
 * 都不可用时回退到 localhost。
 */
function getMediaOrigin(req) {
  if (BROWSER_MEDIA_ORIGIN_EXPLICIT) return BROWSER_MEDIA_ORIGIN_EXPLICIT;
  if (req && req.headers && req.headers.host) {
    return `https://${req.headers.host.replace(/:\d+$/, '')}:${DEFAULT_BROWSER_WSS_PORT}`;
  }
  return `https://localhost:${DEFAULT_BROWSER_WSS_PORT}`;
}

app.use(express.json({ limit: '10mb' }));

// CORS for in-page fetch from https://www.goofish.com to http://127.0.0.1:3210
// Needed because history-sync runs inside goofish.com origin.
const CORS_BUILTIN_PATTERNS = [
  /^https:\/\/www\.goofish\.com$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
];
const CORS_EXTRA_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = origin && (
    CORS_BUILTIN_PATTERNS.some(re => re.test(origin)) ||
    CORS_EXTRA_ORIGINS.includes(origin)
  );
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome Private Network Access (PNA)
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── POST /api/messages/ingest ─────────────────────────────────────────────────
// Body: { sessions: { [chatKey]: { customerName, productId, product, messages[] } } }
// Idempotent — safe to replay the same full snapshot.

app.post('/api/messages/ingest', async (req, res) => {
  const { sessions } = req.body || {};
  if (!sessions || typeof sessions !== 'object') {
    return res.status(400).json({ error: 'body.sessions is required' });
  }
  try {
    const localizedSessions = await localizeSessions(sessions, {
      publicOrigin: getMediaOrigin(req),
    });
    const results = await db.ingest(localizedSessions);
    const totalNew = Object.values(results).reduce((s, r) => s + r.newMsgCount, 0);
    console.log(`[ingest] ${Object.keys(results).length} sessions, ${totalNew} new msgs`);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[ingest]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions ─────────────────────────────────────────────────────────

app.get('/api/sessions', async (_req, res) => {
  try {
    res.json(await db.listSessions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions/:chatKey/messages ───────────────────────────────────────

app.get('/api/sessions/:chatKey/messages', async (req, res) => {
  try {
    const session = await db.getSession(req.params.chatKey);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const messages = await localizeMessages(
      await db.getMessages(req.params.chatKey),
      { publicOrigin: getMediaOrigin(req) }
    );
    res.json({ session, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings ─────────────────────────────────────────────────────────

app.get('/api/settings', async (_req, res) => {
  try {
    res.json(await db.getRuntimeSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/settings ──────────────────────────────────────────────────────

app.patch('/api/settings', async (req, res) => {
  const { autoReplyEnabled, crawlerDesiredEnabled, initialCrawlSessionCount } = req.body || {};
  const hasBool = typeof autoReplyEnabled === 'boolean' || typeof crawlerDesiredEnabled === 'boolean';
  const hasCount = typeof initialCrawlSessionCount === 'number';
  if (!hasBool && !hasCount) {
    return res.status(400).json({ error: 'at least one setting is required' });
  }

  try {
    if (typeof autoReplyEnabled === 'boolean') {
      await db.setAutoReplyEnabled(autoReplyEnabled);
    }
    if (typeof crawlerDesiredEnabled === 'boolean') {
      await db.setCrawlerDesiredEnabled(crawlerDesiredEnabled);
    }
    if (hasCount) {
      await db.setInitialCrawlSessionCount(initialCrawlSessionCount);
    }
    res.json({
      ok: true,
      ...(await db.getRuntimeSettings()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/initial-crawl ─────────────────────────────────────────────────

app.post('/api/initial-crawl', async (_req, res) => {
  try {
    const result = await db.requestInitialCrawl();
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      ...(await db.getRuntimeSettings()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders ───────────────────────────────────────────────────────────

app.get('/api/orders', async (req, res) => {
  try {
    res.json(await db.listOrders({
      linked: req.query.linked,
      q: req.query.q,
      limit: req.query.limit,
      chatKey: req.query.chatKey,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders/runtime ───────────────────────────────────────────────────

app.get('/api/orders/runtime', async (_req, res) => {
  try {
    res.json(await db.getQianniuRuntime());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/full-scan ────────────────────────────────────────────────

app.post('/api/orders/full-scan', async (_req, res) => {
  try {
    const result = await db.requestQianniuFullScan();
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      runtime: result.runtime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/sync-now ────────────────────────────────────────────────

app.post('/api/orders/sync-now', async (_req, res) => {
  try {
    const result = await db.requestQianniuSyncNow();
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      runtime: result.runtime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/browser/heartbeat ──────────────────────────────────────────────

app.post('/api/browser/heartbeat', async (req, res) => {
  const { crawlerEnabled } = req.body || {};
  if (typeof crawlerEnabled !== 'boolean') {
    return res.status(400).json({ error: 'crawlerEnabled must be boolean' });
  }

  try {
    await db.updateCrawlerHeartbeat({ crawlerEnabled });
    res.json({
      ok: true,
      ...(await db.getRuntimeSettings()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outgoing-messages ───────────────────────────────────────────────
// Queue a message to be sent by OpenClaw browser automation.
// Body: { chatKey?, sessionId?, content, source?: 'manual' | 'ai' }

app.post('/api/outgoing-messages', async (req, res) => {
  const {
    chatKey,
    sessionId,
    content,
    messageType = 'text',
    mediaData = null,
    mediaName = null,
    replyToExternalMessageId = null,
    replyToPreview = null,
    replyToType = null,
    source = 'manual',
    customerName = null,
    productId = null,
  } = req.body || {};

  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  if (!chatKey && !sessionId) {
    return res.status(400).json({ error: 'chatKey or sessionId is required' });
  }
  if (!['text', 'image'].includes(messageType)) {
    return res.status(400).json({ error: 'messageType must be text or image' });
  }
  if (!['manual', 'ai'].includes(source)) {
    return res.status(400).json({ error: 'source must be manual or ai' });
  }
  if (messageType === 'text' && !normalizedContent) {
    return res.status(400).json({ error: 'text message content is required' });
  }
  if (messageType === 'image' && (typeof mediaData !== 'string' || !mediaData.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'image message requires mediaData data URL' });
  }
  if (messageType === 'image' && replyToExternalMessageId) {
    return res.status(400).json({ error: 'image reply is not supported yet' });
  }

  try {
    const session = chatKey
      ? await db.getSession(chatKey)
      : await db.getSessionBySessionId(String(sessionId));
    if (!session) return res.status(404).json({ error: 'session not found' });
    const effectiveChatKey = session.chat_key;
    const effectiveSessionId = sessionId ? String(sessionId) : (session.session_id || null);
    const result = await db.addOutgoingMessage(
      effectiveChatKey,
      {
        content: normalizedContent,
        customerName,
        productId,
        source,
        sessionId: effectiveSessionId,
        messageType,
        mediaData,
        mediaName,
        replyToExternalMessageId,
        replyToPreview,
        replyToType,
      }
    );
    console.log(`[outgoing] queued #${result.id} for ${effectiveChatKey} (${source}/${messageType})`);
    res.status(201).json({
      ok: true,
      id: result.id,
      source,
      messageType,
      chatKey: effectiveChatKey,
      sessionId: effectiveSessionId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outgoing-messages ────────────────────────────────────────────────
// ?chatKey=<key>&status=pending|sent|failed

app.get('/api/outgoing-messages', async (req, res) => {
  try {
    res.json(await db.listOutgoingMessages(req.query.chatKey, req.query.status));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outgoing-messages/claim ────────────────────────────────────────

app.post('/api/outgoing-messages/claim', async (_req, res) => {
  try {
    const claimed = await db.claimOutgoingMessage();
    res.json({ ok: true, message: claimed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/outgoing-messages/:id ─────────────────────────────────────────
// Called by OpenClaw after it attempts browser send.
// Body: { status: 'sent' | 'failed' }

app.patch('/api/outgoing-messages/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { status, error: errMsg } = req.body || {};
  if (!['sent', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'status must be sent or failed' });
  }
  try {
    await db.updateOutgoingStatus(id, status, errMsg || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * 确保浏览器脚本使用的 localhost 自签证书存在。
 * 优先使用环境变量显式指定的证书；未指定时，尝试通过 openssl 自动生成一套仅用于本地开发的证书。
 * @returns {{ key: Buffer, cert: Buffer, keyPath: string, certPath: string, generated: boolean }} TLS 材料与来源信息。
 */
function ensureBrowserWssTlsMaterial() {
  const certPath = process.env.BROWSER_WSS_CERT_PATH || path.join(DEFAULT_BROWSER_WSS_CERT_DIR, 'localhost.crt');
  const keyPath = process.env.BROWSER_WSS_KEY_PATH || path.join(DEFAULT_BROWSER_WSS_CERT_DIR, 'localhost.key');
  const certExists = fs.existsSync(certPath);
  const keyExists = fs.existsSync(keyPath);
  let generated = false;

  if (!certExists || !keyExists) {
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });

    const extraSan = (process.env.BROWSER_WSS_CERT_SAN || '').trim();
    const baseSan = 'DNS:localhost,IP:127.0.0.1';
    const fullSan = extraSan ? `${baseSan},${extraSan}` : baseSan;

    const opensslArgs = [
      'req',
      '-x509',
      '-newkey', 'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '3650',
      '-subj', '/CN=localhost',
      '-addext', `subjectAltName=${fullSan}`,
    ];

    let result;
    try {
      result = spawnSync('openssl', opensslArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(
        `无法生成 localhost WSS 证书：${error.message}。`
        + ' 请安装 openssl，或通过 BROWSER_WSS_CERT_PATH / BROWSER_WSS_KEY_PATH 提供证书。'
      );
    }

    if (result.status !== 0) {
      throw new Error(
        `openssl 生成 localhost WSS 证书失败：${(result.stderr || result.stdout || '').trim() || 'unknown error'}`
      );
    }
    generated = true;
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    keyPath,
    certPath,
    generated,
  };
}

/**
 * 统一处理浏览器脚本通过 WSS 发起的 RPC 请求，复用现有数据库能力，避免油猴侧继续轮询 HTTP。
 * @param {string} action - RPC 动作名。
 * @param {Record<string, any>} payload - RPC 负载。
 * @returns {Promise<any>} RPC 响应数据。
 */
async function handleBrowserRpcAction(action, payload = {}) {
  switch (action) {
    case 'settings.patch': {
      const { autoReplyEnabled, crawlerDesiredEnabled } = payload;
      if (typeof autoReplyEnabled !== 'boolean' && typeof crawlerDesiredEnabled !== 'boolean') {
        throw new Error('at least one boolean setting is required');
      }

      if (typeof autoReplyEnabled === 'boolean') {
        await db.setAutoReplyEnabled(autoReplyEnabled);
      }
      if (typeof crawlerDesiredEnabled === 'boolean') {
        await db.setCrawlerDesiredEnabled(crawlerDesiredEnabled);
      }
      return await db.getRuntimeSettings();
    }

    case 'browser.heartbeat': {
      const { crawlerEnabled, initialCrawlNonceHandled } = payload;
      if (typeof crawlerEnabled !== 'boolean') {
        throw new Error('crawlerEnabled must be boolean');
      }

      await db.updateCrawlerHeartbeat({ crawlerEnabled, initialCrawlNonceHandled });
      return await db.getRuntimeSettings();
    }

    case 'orders.heartbeat': {
      const {
        pageUrl = '',
        visibleOrderCount = 0,
        scanState = 'idle',
        scanNonceHandled = null,
        syncNonceHandled = null,
      } = payload || {};
      const runtime = await db.updateQianniuHeartbeat({
        pageUrl,
        visibleOrderCount,
        scanState,
        scanNonceHandled,
        syncNonceHandled,
      });
      return {
        syncNowNonce: runtime.syncNowNonce,
        fullScanNonce: runtime.fullScanNonce,
        runtime,
      };
    }

    case 'orders.ingest': {
      const { orders, pageContext = {} } = payload || {};
      if (!Array.isArray(orders)) {
        throw new Error('orders must be an array');
      }
      return await db.ingestOrders(orders, pageContext);
    }

    case 'outgoing.claim':
      return { message: await db.claimOutgoingMessage() };

    case 'media.cache': {
      const urlList = Array.isArray(payload.urls)
        ? payload.urls
        : (payload.url ? [payload.url] : []);
      if (!urlList.length) {
        throw new Error('url or urls is required');
      }

      const urls = await cacheRemoteImages(urlList, {
        publicOrigin: getMediaOrigin(null),
      });

      return {
        url: payload.url ? (urls[payload.url] || payload.url) : null,
        urls,
      };
    }

    case 'outgoing.patch': {
      const id = Number(payload.id);
      const { status, error } = payload;
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error('id must be a positive integer');
      }
      if (!['sent', 'failed'].includes(status)) {
        throw new Error('status must be sent or failed');
      }

      await db.updateOutgoingStatus(id, status, error || null);
      return { ok: true };
    }

    default:
      throw new Error(`unsupported action: ${action}`);
  }
}

/**
 * 向浏览器脚本返回统一的 WSS RPC 响应格式。
 * @param {import('ws')} socket - 当前连接。
 * @param {string | number | null} id - 请求 ID。
 * @param {{ ok: boolean, payload?: any, error?: string }} message - 响应内容。
 */
function sendBrowserRpcResponse(socket, id, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: 'rpc-response',
    id,
    ...message,
  }));
}

/**
 * 启动供油猴脚本使用的 localhost WSS 服务。
 * 该服务只承担浏览器脚本和本地 Node 服务之间的轻量 RPC，不替代现有 3210 HTTP UI。
 * @returns {{ httpsServer: import('https').Server, wss: WebSocketServer, port: number, path: string }} WSS 服务句柄。
 */
function startBrowserWssServer() {
  const tlsMaterial = ensureBrowserWssTlsMaterial();
  const port = DEFAULT_BROWSER_WSS_PORT;
  const wssPath = DEFAULT_BROWSER_WSS_PATH;

  const httpsServer = https.createServer(
    {
      key: tlsMaterial.key,
      cert: tlsMaterial.cert,
    },
    (req, res) => {
      if (serveCachedMediaRequest(req, res)) {
        return;
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          wssPath,
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  );

  const wss = new WebSocketServer({
    server: httpsServer,
    path: wssPath,
    perMessageDeflate: false,
  });

  wss.on('connection', (socket) => {
    socket.on('message', async (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch (_) {
        sendBrowserRpcResponse(socket, null, {
          ok: false,
          error: 'invalid json payload',
        });
        return;
      }

      const requestId = message?.id ?? null;
      const action = message?.action;
      if (!action) {
        sendBrowserRpcResponse(socket, requestId, {
          ok: false,
          error: 'action is required',
        });
        return;
      }

      try {
        const payload = await handleBrowserRpcAction(action, message?.payload || {});
        sendBrowserRpcResponse(socket, requestId, {
          ok: true,
          payload,
        });
      } catch (error) {
        sendBrowserRpcResponse(socket, requestId, {
          ok: false,
          error: error.message || String(error),
        });
      }
    });
  });

  httpsServer.listen(port, SERVER_BIND_HOST, () => {
    console.log(`[browser-wss] wss://${SERVER_BIND_HOST}:${port}${wssPath}`);
    console.log(`[browser-wss] health https://${SERVER_BIND_HOST}:${port}/health`);
    if (tlsMaterial.generated) {
      console.log(`[browser-wss] generated localhost cert: ${tlsMaterial.certPath}`);
      console.log(`[browser-wss] generated localhost key: ${tlsMaterial.keyPath}`);
    }
  });

  return { httpsServer, wss, port, path: wssPath };
}

/**
 * 初始化服务启动时需要的运行时设置，避免 UI 开关缺省态不确定。
 * @returns {Promise<void>}
 */
async function bootstrapSettings() {
  await db.ensureRuntimeSettings({
    autoReplyEnabled: process.env.AUTO_REPLY_ENABLED !== '0',
    crawlerDesiredEnabled: process.env.CRAWLER_DESIRED_ENABLED !== '0',
  });
  // 每次服务启动时生成新的初始遍历 nonce，油猴脚本首次 heartbeat 时触发遍历
  await db.requestInitialCrawl();
}

/**
 * 如果 public/ 目录不存在，自动构建前端。
 */
function ensureFrontendBuilt() {
  const publicDir = path.join(__dirname, 'public');
  const frontendDir = path.join(__dirname, 'frontend');
  if (fs.existsSync(publicDir) || !fs.existsSync(frontendDir)) return;

  console.log('[server] public/ not found, building frontend...');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: frontendDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.warn('[server] frontend build failed, continuing without static files');
  }
}

/**
 * 启动 Express 与自动回复 worker。
 * @returns {Promise<void>}
 */
async function startServer() {
  ensureFrontendBuilt();
  await bootstrapSettings();
  startBrowserWssServer();

  app.listen(PORT, SERVER_BIND_HOST, () => {
    console.log(`[server] http://${SERVER_BIND_HOST}:${PORT}`);
    const intervalMs = parseInt(process.env.AUTO_REPLY_INTERVAL_MS || '3000', 10);
    startAutoReplyWorker({ intervalMs });
  });
}

startServer().catch((err) => {
  console.error('[server] bootstrap failed:', err);
  process.exit(1);
});
