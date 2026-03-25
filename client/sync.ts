// @ts-nocheck
'use strict';

const path = require('path');
const { loadOptionalEnvFiles } = require('../load_env.ts');

loadOptionalEnvFiles([
  path.join(__dirname, '.env'),
]);

/**
 * sync.ts — Xianyu chat history syncer (long-running daemon)
 * Reads xm_chat_history from the OpenClaw browser (goofish.com/im tab)
 * via Chrome DevTools Protocol (CDP), then POSTs it to the local ingest API.
 *
 * Runs continuously, syncing every SYNC_INTERVAL ms (default 5000).
 *
 * Usage:
 *   node sync.ts
 *   CDP_PORT=18800 SERVER_PORT=3210 SYNC_INTERVAL=5000 node sync.ts
 */

const CDP_PORT = process.env.CDP_PORT || 18800;
const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:3210';
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL, 10) || 5000;

const { WebSocket } = require('ws');

let ws: InstanceType<typeof WebSocket> | null = null;
let wsUrl: string | null = null;
let msgId = 0;
let lastHash: string | null = null;
let stopping = false;

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[sync] received ${signal}, shutting down...`);
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Simple hash for change detection ───────────────────────────────
function simpleHash(str: string): string {
  return require('crypto').createHash('md5').update(str).digest('hex');
}

// ── Find goofish IM tab ────────────────────────────────────────────
async function findTab(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  if (!res.ok) throw new Error(`CDP not available at port ${CDP_PORT}`);
  const tabs = await res.json();
  const tab = tabs.find(t => t.url && t.url.includes('goofish.com/im') && t.type === 'page');
  if (!tab) throw new Error('goofish.com/im tab not found');
  return tab.webSocketDebuggerUrl || `ws://127.0.0.1:${CDP_PORT}/devtools/page/${tab.id}`;
}

// ── Ensure WebSocket connection ────────────────────────────────────
function ensureConnection(url: string): Promise<InstanceType<typeof WebSocket>> {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN && wsUrl === url) {
      return resolve(ws);
    }
    // Close stale connection
    if (ws) {
      try { ws.close(); } catch (_) { }
      ws = null;
    }
    wsUrl = url;
    ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => {
      ws = null;
      reject(err);
    });
    setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        ws.close();
        ws = null;
        reject(new Error('WebSocket connect timeout'));
      }
    }, 10000);
  });
}

// ── Evaluate expression via CDP ────────────────────────────────────
function evalInTab(expression: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket not connected'));
    }
    const id = ++msgId;
    let done = false;

    const onMessage = (data) => {
      if (done) return;
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        done = true;
        ws.removeListener('message', onMessage);
        const val = msg.result?.result?.value;
        if (msg.result?.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.text || 'CDP eval error'));
        } else {
          resolve(val != null ? String(val) : '');
        }
      }
    };

    ws.on('message', onMessage);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false },
    }));

    setTimeout(() => {
      if (!done) {
        done = true;
        ws.removeListener('message', onMessage);
        reject(new Error('CDP eval timeout'));
      }
    }, 10000);
  });
}

// ── Single sync cycle ──────────────────────────────────────────────
async function syncOnce(): Promise<void> {
  // 1. Find tab & connect
  const url = await findTab();
  await ensureConnection(url);

  // 2. Read localStorage
  const raw = await evalInTab(`localStorage.getItem('xm_chat_history') || ''`);
  if (!raw || raw === 'null' || raw === '{}' || raw === '') {
    console.log('[sync] xm_chat_history is empty, skipping');
    return;
  }

  // 3. Skip if data unchanged
  const hash = simpleHash(raw);
  if (hash === lastHash) {
    console.log('[sync] data unchanged, skipping');
    return;
  }

  console.log(`[sync] xm_chat_history size: ${raw.length} bytes`);

  // 4. Parse and POST
  let sessions;
  try {
    sessions = JSON.parse(raw);
  } catch (e) {
    console.error('[sync] JSON parse error:', e.message);
    return;
  }

  const ingestRes = await fetch(`${SERVER_URL}/api/messages/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
  });

  if (!ingestRes.ok) {
    console.error(`[sync] ingest HTTP ${ingestRes.status}`);
    return;
  }

  const result = await ingestRes.json();
  lastHash = hash;
  console.log('[sync] ingest result:', JSON.stringify(result));
}

// ── Main loop ──────────────────────────────────────────────────────
async function loop(): Promise<void> {
  console.log(`[sync] starting daemon — interval ${SYNC_INTERVAL}ms`);

  while (!stopping) {
    try {
      await syncOnce();
    } catch (err) {
      console.error('[sync] error:', err.message);
      // Reset connection on error so next cycle reconnects
      if (ws) { try { ws.close(); } catch (_) { } ws = null; }
    }
    // Wait for next cycle
    await new Promise(r => setTimeout(r, SYNC_INTERVAL));
  }
}

loop();
