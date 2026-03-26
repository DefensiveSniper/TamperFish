// @ts-nocheck
'use strict';

const path = require('path');
const { loadOptionalEnvFiles } = require('../load_env.ts');

loadOptionalEnvFiles([
  path.join(__dirname, '.env'),
]);

const express = require('express');
const fs = require('fs');
const { spawnSync } = require('child_process');
const db = require('./db.ts');
const { startAutoReplyWorker } = require('./auto_reply_worker.ts');
const {
  cacheRemoteImages,
  localizeMessages,
  localizeSessions,
} = require('./media_cache.ts');

const app = express();
const PORT = process.env.PORT || 3210;
const SERVER_BIND_HOST = process.env.SERVER_BIND_HOST || '0.0.0.0';
const PUBLIC_MEDIA_ORIGIN_EXPLICIT = process.env.SERVER_PUBLIC_ORIGIN || process.env.BROWSER_MEDIA_ORIGIN || '';

/**
 * 获取媒体缓存资源的公开访问源。
 * 优先使用环境变量显式设置；未设置时，尝试从 HTTP 请求的 Host 头推导；
 * 都不可用时回退到 localhost。
 */
function getMediaOrigin(req) {
  if (PUBLIC_MEDIA_ORIGIN_EXPLICIT) return PUBLIC_MEDIA_ORIGIN_EXPLICIT;
  if (req && req.headers && req.headers.host) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    return `${protocol}://${req.headers.host}`;
  }
  return `http://localhost:${PORT}`;
}

app.use(express.json({ limit: '10mb' }));

const CORS_BUILTIN_PATTERNS = [
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

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
  const { crawlerEnabled, initialCrawlNonceHandled = null } = req.body || {};
  if (typeof crawlerEnabled !== 'boolean') {
    return res.status(400).json({ error: 'crawlerEnabled must be boolean' });
  }

  try {
    await db.updateCrawlerHeartbeat({ crawlerEnabled, initialCrawlNonceHandled });
    res.json({
      ok: true,
      ...(await db.getRuntimeSettings()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/heartbeat ──────────────────────────────────────────────

app.post('/api/orders/heartbeat', async (req, res) => {
  try {
    res.json(await db.updateQianniuHeartbeat(req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/ingest ─────────────────────────────────────────────────

app.post('/api/orders/ingest', async (req, res) => {
  const { orders, pageContext = {} } = req.body || {};
  if (!Array.isArray(orders)) {
    return res.status(400).json({ error: 'orders must be an array' });
  }

  try {
    res.json(await db.ingestOrders(orders, pageContext));
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
