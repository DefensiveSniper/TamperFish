// @ts-nocheck
'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { buildServerApiRequest } = require('./browser_bridge_actions.ts');
const { computeCertificateSpkiHash } = require('./chrome_tls.ts');
const { cacheRemoteImages, serveCachedMediaRequest } = require('./media_cache.ts');
const { loadOptionalEnvFiles } = require('../load_env.ts');

loadOptionalEnvFiles([
  path.join(__dirname, '.env'),
]);

const DEFAULT_BROWSER_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BROWSER_WSS_PORT = 3211;
const DEFAULT_BROWSER_WSS_PATH = '/ws/browser';
const DEFAULT_BROWSER_WSS_CERT_DIR = path.join(__dirname, '.localhost-wss');
const DEFAULT_BROWSER_HEARTBEAT_INTERVAL_MS = 3000;

let browserHeartbeatTimer = null;

function log(message) {
  process.stdout.write(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] [bridge-only] ${message}\n`);
}

function encodeHeaderValue(value) {
  return encodeURIComponent(String(value || ''));
}

function buildLocalBrowserOrigin(config) {
  return `https://${config.browserBridgeHost}:${config.browserWssPort}`;
}

function ensureBrowserBridgeTlsMaterial() {
  const certPath = process.env.BROWSER_WSS_CERT_PATH || path.join(DEFAULT_BROWSER_WSS_CERT_DIR, 'localhost.crt');
  const keyPath = process.env.BROWSER_WSS_KEY_PATH || path.join(DEFAULT_BROWSER_WSS_CERT_DIR, 'localhost.key');
  const certExists = fs.existsSync(certPath);
  const keyExists = fs.existsSync(keyPath);

  if (!certExists || !keyExists) {
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });

    const extraSan = (process.env.BROWSER_WSS_CERT_SAN || '').trim();
    const baseSan = 'DNS:localhost,IP:127.0.0.1';
    const fullSan = extraSan ? `${baseSan},${extraSan}` : baseSan;
    const result = spawnSync('openssl', [
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
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      throw new Error(
        `openssl 生成 localhost bridge 证书失败：${(result.stderr || result.stdout || '').trim() || 'unknown error'}`
      );
    }
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    keyPath,
    certPath,
  };
}

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

function stripOkEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.ok !== true) {
    return payload;
  }

  const { ok, ...rest } = payload;
  return rest;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

async function forwardBrowserActionToServer(config, action, payload = {}) {
  const request = buildServerApiRequest(action, payload);
  if (!request) {
    throw new Error(`action is local-only: ${action}`);
  }

  const response = await fetch(`${config.serverUrl}${request.path}`, {
    method: request.method,
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': encodeHeaderValue(config.clientId),
      'X-Client-Secret': encodeHeaderValue(config.clientSecret),
      'X-Account-Id': encodeHeaderValue(config.accountId),
    },
    body: request.method === 'GET' ? undefined : JSON.stringify(request.body || {}),
  });
  const responsePayload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(responsePayload?.error || `server http ${response.status}`);
  }

  if (action === 'settings.patch' || action === 'browser.heartbeat') {
    return stripOkEnvelope(responsePayload);
  }
  return responsePayload;
}

async function handleBrowserRpcAction(config, action, payload = {}) {
  if (action === 'media.cache') {
    const urlList = Array.isArray(payload.urls)
      ? payload.urls
      : (payload.url ? [payload.url] : []);
    if (!urlList.length) {
      throw new Error('url or urls is required');
    }

    const urls = await cacheRemoteImages(urlList, {
      publicOrigin: buildLocalBrowserOrigin(config),
    });

    return {
      url: payload.url ? (urls[payload.url] || payload.url) : null,
      urls,
    };
  }

  return await forwardBrowserActionToServer(config, action, payload);
}

async function syncBrowserHeartbeat(config) {
  try {
    await forwardBrowserActionToServer(config, 'browser.heartbeat', {
      crawlerEnabled: false,
      initialCrawlNonceHandled: null,
    });
  } catch (error) {
    log(`browser heartbeat 失败: ${error.message || error}`);
  }
}

function startBrowserHeartbeatLoop(config) {
  if (browserHeartbeatTimer) {
    clearInterval(browserHeartbeatTimer);
  }

  syncBrowserHeartbeat(config);
  browserHeartbeatTimer = setInterval(() => {
    syncBrowserHeartbeat(config);
  }, DEFAULT_BROWSER_HEARTBEAT_INTERVAL_MS);
}

async function main() {
  const config = {
    serverUrl: process.env.SERVER_URL || 'http://127.0.0.1:3210',
    browserBridgeHost: process.env.BROWSER_BIND_HOST || DEFAULT_BROWSER_BRIDGE_HOST,
    browserWssPort: Number(process.env.BROWSER_WSS_PORT || DEFAULT_BROWSER_WSS_PORT),
    clientId: process.env.CLIENT_ID || 'legacy-client-1',
    clientSecret: process.env.CLIENT_SECRET || '',
    accountId: process.env.ACCOUNT_ID || 'default',
    clientName: process.env.CLIENT_NAME || '',
  };

  const regResp = await fetch(`${config.serverUrl}/api/clients/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': encodeHeaderValue(config.clientId),
      'X-Client-Secret': encodeHeaderValue(config.clientSecret),
      'X-Account-Id': encodeHeaderValue(config.accountId),
    },
    body: JSON.stringify({
      clientId: config.clientId,
      accountId: config.accountId,
      clientName: config.clientName,
      clientSecret: config.clientSecret,
      capabilities: ['crawler'],
    }),
  });

  if (!regResp.ok) {
    const body = await regResp.text();
    throw new Error(`client 注册失败 (${regResp.status}): ${body}`);
  }

  const tlsMaterial = ensureBrowserBridgeTlsMaterial();
  const spkiHash = computeCertificateSpkiHash(tlsMaterial.certPath);
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
        res.end(JSON.stringify({ ok: true, wssPath: DEFAULT_BROWSER_WSS_PATH }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  );

  const wss = new WebSocketServer({
    server: httpsServer,
    path: DEFAULT_BROWSER_WSS_PATH,
    perMessageDeflate: false,
  });

  wss.on('connection', (socket) => {
    socket.on('message', async (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch (_) {
        sendBrowserRpcResponse(socket, null, { ok: false, error: 'invalid json payload' });
        return;
      }

      const requestId = message?.id ?? null;
      const action = message?.action;
      if (!action) {
        sendBrowserRpcResponse(socket, requestId, { ok: false, error: 'action is required' });
        return;
      }

      try {
        const responsePayload = await handleBrowserRpcAction(config, action, message?.payload || {});
        sendBrowserRpcResponse(socket, requestId, { ok: true, payload: responsePayload });
      } catch (error) {
        sendBrowserRpcResponse(socket, requestId, {
          ok: false,
          error: error.message || String(error),
        });
      }
    });
  });

  httpsServer.listen(config.browserWssPort, config.browserBridgeHost, () => {
    log(`本地 browser bridge 已启动: ${buildLocalBrowserOrigin(config)}${DEFAULT_BROWSER_WSS_PATH}`);
    if (spkiHash) {
      log(`bridge 证书 SPKI: ${spkiHash}`);
    }
  });

  startBrowserHeartbeatLoop(config);

  const shutdown = () => {
    if (browserHeartbeatTimer) {
      clearInterval(browserHeartbeatTimer);
      browserHeartbeatTimer = null;
    }
    try {
      wss.close();
      httpsServer.close();
    } catch (_) {
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[bridge-only] ${error.message || error}`);
  process.exit(1);
});