'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { startAutoReplyWorker } = require('./auto_reply_worker');

const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.json({ limit: '10mb' }));

// CORS for in-page fetch from https://www.goofish.com to http://127.0.0.1:3210
// Needed because history-sync runs inside goofish.com origin.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Allow goofish origin (and local dev)
  const allow = origin && (/^https:\/\/www\.goofish\.com$/i.test(origin) || /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) || /^https?:\/\/localhost(?::\d+)?$/i.test(origin));
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
    const results = await db.ingest(sessions);
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
    const messages = await db.getMessages(req.params.chatKey);
    res.json({ session, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings ─────────────────────────────────────────────────────────

app.get('/api/settings', async (_req, res) => {
  try {
    res.json({
      autoReplyEnabled: await db.isAutoReplyEnabled(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/settings ──────────────────────────────────────────────────────

app.patch('/api/settings', async (req, res) => {
  const { autoReplyEnabled } = req.body || {};
  if (typeof autoReplyEnabled !== 'boolean') {
    return res.status(400).json({ error: 'autoReplyEnabled must be boolean' });
  }

  try {
    await db.setAutoReplyEnabled(autoReplyEnabled);
    res.json({
      ok: true,
      autoReplyEnabled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outgoing-messages ───────────────────────────────────────────────
// Queue a message to be sent by OpenClaw browser automation.
// Body: { chatKey, content, source?: 'manual' | 'ai' }

app.post('/api/outgoing-messages', async (req, res) => {
  const { chatKey, content, source = 'manual' } = req.body || {};
  if (!chatKey || !content) {
    return res.status(400).json({ error: 'chatKey and content are required' });
  }
  if (!['manual', 'ai'].includes(source)) {
    return res.status(400).json({ error: 'source must be manual or ai' });
  }
  try {
    const session = await db.getSession(chatKey);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const result = await db.addOutgoingMessage(chatKey, content, null, null, source);
    console.log(`[outgoing] queued #${result.id} for ${chatKey} (${source})`);
    res.status(201).json({ ok: true, id: result.id, source });
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
  });
}

/**
 * 启动 Express 与自动回复 worker。
 * @returns {Promise<void>}
 */
async function startServer() {
  await bootstrapSettings();

  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
    const intervalMs = parseInt(process.env.AUTO_REPLY_INTERVAL_MS || '3000', 10);
    startAutoReplyWorker({ intervalMs });
  });
}

startServer().catch((err) => {
  console.error('[server] bootstrap failed:', err);
  process.exit(1);
});
