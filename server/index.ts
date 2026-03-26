// @ts-nocheck
'use strict';

const path = require('path');
const { loadOptionalEnvFiles } = require('../load_env.ts');

loadOptionalEnvFiles([
  path.join(__dirname, '.env'),
]);

const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id, X-Client-Secret, X-Account-Id');
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Client auth middleware ────────────────────────────────────────────────────
// Client-facing APIs require X-Client-Id + X-Client-Secret headers.
// Frontend/console APIs use X-Account-Id (or default account).

async function authenticateClient(req, res, next) {
  const clientId = req.headers['x-client-id'];
  const clientSecret = req.headers['x-client-secret'];

  if (!clientId) {
    return res.status(401).json({ error: 'X-Client-Id header is required' });
  }

  const client = await db.getClient(clientId);
  if (!client || client.status !== 'active') {
    return res.status(401).json({ error: 'unknown or disabled client' });
  }

  // Verify secret if one is stored
  if (client.client_secret_hash && clientSecret) {
    const hash = crypto.createHash('sha256').update(clientSecret).digest('hex');
    if (hash !== client.client_secret_hash) {
      return res.status(401).json({ error: 'invalid client secret' });
    }
  }

  req.client = client;
  req.accountId = client.account_id;
  req.clientId = client.client_id;
  next();
}

function resolveAccountId(req) {
  // For frontend: prefer explicit header, fallback to default
  return req.headers['x-account-id'] || req.query.accountId || db.DEFAULT_ACCOUNT_ID;
}

function resolveClientId(req) {
  return req.headers['x-client-id'] || req.query.clientId || db.LEGACY_CLIENT_ID;
}

// ── POST /api/messages/ingest (client-facing) ────────────────────────────────

app.post('/api/messages/ingest', authenticateClient, async (req, res) => {
  const { sessions } = req.body || {};
  if (!sessions || typeof sessions !== 'object') {
    return res.status(400).json({ error: 'body.sessions is required' });
  }
  try {
    const localizedSessions = await localizeSessions(sessions, {
      publicOrigin: getMediaOrigin(req),
    });
    const results = await db.ingest(req.accountId, req.clientId, localizedSessions);
    const totalNew = Object.values(results).reduce((s, r) => s + r.newMsgCount, 0);
    console.log(`[ingest] ${req.clientId}: ${Object.keys(results).length} sessions, ${totalNew} new msgs`);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[ingest]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions (frontend) ────────────────────────────────────────────

app.get('/api/sessions', async (req, res) => {
  try {
    const accountId = resolveAccountId(req);
    res.json(await db.listSessions(accountId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions/:chatKey/messages (frontend) ───────────────────────────

app.get('/api/sessions/:chatKey/messages', async (req, res) => {
  try {
    const accountId = resolveAccountId(req);
    const session = await db.getSession(accountId, req.params.chatKey);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const messages = await localizeMessages(
      await db.getMessages(accountId, req.params.chatKey),
      { publicOrigin: getMediaOrigin(req) }
    );
    res.json({ session, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings (frontend) ────────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  try {
    const accountId = resolveAccountId(req);
    const clientId = resolveClientId(req);
    res.json(await db.getRuntimeSettings(accountId, clientId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/settings (frontend) ──────────────────────────────────────────

app.patch('/api/settings', async (req, res) => {
  const { autoReplyEnabled, crawlerDesiredEnabled, initialCrawlSessionCount } = req.body || {};
  const hasBool = typeof autoReplyEnabled === 'boolean' || typeof crawlerDesiredEnabled === 'boolean';
  const hasCount = typeof initialCrawlSessionCount === 'number';
  if (!hasBool && !hasCount) {
    return res.status(400).json({ error: 'at least one setting is required' });
  }

  try {
    const accountId = resolveAccountId(req);
    const clientId = resolveClientId(req);

    if (typeof autoReplyEnabled === 'boolean') {
      await db.setAutoReplyEnabled(accountId, autoReplyEnabled);
    }
    if (typeof crawlerDesiredEnabled === 'boolean') {
      await db.setCrawlerDesiredEnabled(clientId, crawlerDesiredEnabled);
    }
    if (hasCount) {
      await db.setInitialCrawlSessionCount(clientId, initialCrawlSessionCount);
    }
    res.json({
      ok: true,
      ...(await db.getRuntimeSettings(accountId, clientId)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/initial-crawl (frontend → targets a client) ──────────────────

app.post('/api/initial-crawl', async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const result = await db.requestInitialCrawl(clientId);
    const accountId = resolveAccountId(req);
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      ...(await db.getRuntimeSettings(accountId, clientId)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders (frontend) ──────────────────────────────────────────────

app.get('/api/orders', async (req, res) => {
  try {
    const accountId = resolveAccountId(req);
    res.json(await db.listOrders(accountId, {
      linked: req.query.linked,
      q: req.query.q,
      limit: req.query.limit,
      chatKey: req.query.chatKey,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders/runtime (frontend) ──────────────────────────────────────

app.get('/api/orders/runtime', async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    res.json(await db.getQianniuRuntime(clientId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/full-scan (frontend → targets a client) ────────────────

app.post('/api/orders/full-scan', async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const result = await db.requestQianniuFullScan(clientId);
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      runtime: await db.getQianniuRuntime(clientId),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/sync-now (frontend → targets a client) ────────────────

app.post('/api/orders/sync-now', async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const result = await db.requestQianniuSyncNow(clientId);
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      runtime: await db.getQianniuRuntime(clientId),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/browser/heartbeat (client-facing) ────────────────────────────

app.post('/api/browser/heartbeat', authenticateClient, async (req, res) => {
  const { crawlerEnabled, initialCrawlNonceHandled = null } = req.body || {};
  if (typeof crawlerEnabled !== 'boolean') {
    return res.status(400).json({ error: 'crawlerEnabled must be boolean' });
  }

  try {
    await db.updateCrawlerHeartbeat(req.clientId, { crawlerEnabled });
    if (initialCrawlNonceHandled) {
      await db.handleCommandNonce(req.clientId, 'initial_crawl', initialCrawlNonceHandled);
    }
    res.json({
      ok: true,
      ...(await db.getRuntimeSettings(req.accountId, req.clientId)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/heartbeat (client-facing) ─────────────────────────────

app.post('/api/orders/heartbeat', authenticateClient, async (req, res) => {
  try {
    res.json(await db.updateQianniuHeartbeat(req.clientId, req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders/ingest (client-facing) ─────────────────────────────────

app.post('/api/orders/ingest', authenticateClient, async (req, res) => {
  const { orders, pageContext = {} } = req.body || {};
  if (!Array.isArray(orders)) {
    return res.status(400).json({ error: 'orders must be an array' });
  }

  try {
    res.json(await db.ingestOrders(req.accountId, req.clientId, orders, pageContext));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outgoing-messages (frontend) ──────────────────────────────────

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
    const accountId = resolveAccountId(req);
    const session = chatKey
      ? await db.getSession(accountId, chatKey)
      : await db.getSessionBySessionId(accountId, String(sessionId));
    if (!session) return res.status(404).json({ error: 'session not found' });
    const effectiveChatKey = session.chat_key;
    const effectiveSessionId = sessionId ? String(sessionId) : (session.session_id || null);
    const result = await db.addOutgoingMessage(
      accountId,
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

// ── GET /api/outgoing-messages (frontend) ───────────────────────────────────

app.get('/api/outgoing-messages', async (req, res) => {
  try {
    const accountId = resolveAccountId(req);
    res.json(await db.listOutgoingMessages(accountId, req.query.chatKey, req.query.status));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outgoing-messages/claim (client-facing) ───────────────────────

app.post('/api/outgoing-messages/claim', authenticateClient, async (req, res) => {
  try {
    const claimed = await db.claimOutgoingMessage(req.clientId);
    res.json({ ok: true, message: claimed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/outgoing-messages/:id (client-facing) ────────────────────────

app.patch('/api/outgoing-messages/:id', authenticateClient, async (req, res) => {
  const id = Number(req.params.id);
  const { status, error: errMsg } = req.body || {};
  if (!['sent', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'status must be sent or failed' });
  }
  try {
    await db.updateOutgoingStatus(id, req.clientId, status, errMsg || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Client management APIs (frontend) ───────────────────────────────────────

app.get('/api/clients', async (req, res) => {
  try {
    const accountId = resolveAccountId(req);
    const clients = await db.listClients(accountId);
    // Enrich with runtime info
    const enriched = await Promise.all(clients.map(async (client) => {
      const heartbeat = await db.getClientRuntime(client.client_id, 'crawler_last_heartbeat_at', '0');
      const heartbeatTs = Number(heartbeat || 0);
      const isOnline = heartbeatTs > 0 && (Math.floor(Date.now() / 1000) - heartbeatTs) <= 12;
      return { ...client, isOnline, lastHeartbeatAt: heartbeatTs };
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/:clientId/runtime', async (req, res) => {
  try {
    const client = await db.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'client not found' });
    const [settings, qianniu] = await Promise.all([
      db.getRuntimeSettings(client.account_id, client.client_id),
      db.getQianniuRuntime(client.client_id),
    ]);
    res.json({ settings, qianniu, client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/:clientId/initial-crawl', async (req, res) => {
  try {
    const client = await db.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'client not found' });
    const result = await db.requestInitialCrawl(client.client_id);
    res.status(202).json({ ok: true, requestedNonce: result.requestedNonce });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/:clientId/orders/sync-now', async (req, res) => {
  try {
    const client = await db.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'client not found' });
    const result = await db.requestQianniuSyncNow(client.client_id);
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      runtime: await db.getQianniuRuntime(client.client_id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/:clientId/orders/full-scan', async (req, res) => {
  try {
    const client = await db.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'client not found' });
    const result = await db.requestQianniuFullScan(client.client_id);
    res.status(202).json({
      ok: true,
      requestedNonce: result.requestedNonce,
      runtime: await db.getQianniuRuntime(client.client_id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/register', async (req, res) => {
  const { clientId, accountId, clientName, clientSecret, capabilities } = req.body || {};
  if (!clientId || !accountId) {
    return res.status(400).json({ error: 'clientId and accountId are required' });
  }
  try {
    const secretHash = clientSecret
      ? crypto.createHash('sha256').update(clientSecret).digest('hex')
      : '';
    await db.registerClient(clientId, accountId, clientName || '', secretHash, capabilities || []);
    // Ensure default settings for this client
    await db.ensureRuntimeSettings(accountId, clientId, {
      autoReplyEnabled: process.env.AUTO_REPLY_ENABLED !== '0',
      crawlerDesiredEnabled: process.env.CRAWLER_DESIRED_ENABLED !== '0',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SPA fallback ────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function bootstrapSettings() {
  // Ensure legacy client exists for backward compatibility
  await db.registerClient(
    db.LEGACY_CLIENT_ID,
    db.DEFAULT_ACCOUNT_ID,
    'Legacy Client',
    '',
    ['crawler', 'qianniu']
  );

  await db.ensureRuntimeSettings(db.DEFAULT_ACCOUNT_ID, db.LEGACY_CLIENT_ID, {
    autoReplyEnabled: process.env.AUTO_REPLY_ENABLED !== '0',
    crawlerDesiredEnabled: process.env.CRAWLER_DESIRED_ENABLED !== '0',
  });

  // Request initial crawl on startup
  await db.requestInitialCrawl(db.LEGACY_CLIENT_ID);
}

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
