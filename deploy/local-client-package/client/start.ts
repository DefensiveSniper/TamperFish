// @ts-nocheck
'use strict';

const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { buildServerApiRequest } = require('./browser_bridge_actions.ts');
const { buildChromeTlsArgs, computeCertificateSpkiHash } = require('./chrome_tls.ts');
const { cacheRemoteImages, serveCachedMediaRequest } = require('./media_cache.ts');
const { loadOptionalEnvFiles } = require('../load_env.ts');

loadOptionalEnvFiles([
  path.join(__dirname, '.env'),
]);

const DEFAULT_CDP_PORT = 18800;
const DEFAULT_SYNC_INTERVAL = 5000;
const DEFAULT_PROFILE_NAME = 'xianyu';
const DEFAULT_GOOFISH_URL = 'https://www.goofish.com/im';
const DEFAULT_QIANNIU_URL = 'https://myseller.taobao.com/home.htm/batch-consign';
const DEFAULT_CHROME_MONITOR_INTERVAL_MS = 3000;
const DEFAULT_CHROME_USER_DATA_DIR = path.join(__dirname, '..', '.chrome-xianyu-profile');
const DEFAULT_CHROME_PROFILE_DIRECTORY = 'Default';
const DEFAULT_RUNTIME_LOG_PATH = path.join(__dirname, 'client.log');
const DEFAULT_CHROME_PROXY_CONFIG_PATH = path.join(__dirname, '.chrome-proxy.local.json');
const DEFAULT_CHROME_PROXY_SCHEME = 'http';
const DEFAULT_CHROME_PROXY_BYPASS_LIST = 'localhost;127.0.0.1;::1';
const DEFAULT_CHROME_PROXY_EXTENSION_DIR = path.join(__dirname, '.chrome-proxy-extension');
const DEFAULT_CHROME_CLEAR_TRANSIENT_DATA_ON_START = true;
const DEFAULT_CHROME_START_TIMEOUT_MS = 15000;
const DEFAULT_CHROME_REPAIR_TAMPERMONKEY_WEBREQUEST_ON_START = true;
const DEFAULT_TAMPERMONKEY_WEBREQUEST_EVENT_THRESHOLD = 4096;
const DEFAULT_BROWSER_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BROWSER_WSS_PORT = 3211;
const DEFAULT_BROWSER_WSS_PATH = '/ws/browser';
const DEFAULT_BROWSER_WSS_CERT_DIR = path.join(__dirname, '.localhost-wss');
const DEFAULT_BROWSER_HEARTBEAT_INTERVAL_MS = 3000;
const DEFAULT_INITIAL_CRAWL_SESSION_COUNT = 30;
const CHROME_SINGLETON_ARTIFACTS = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'DevToolsActivePort',
];
const CHROME_ROOT_TRANSIENT_ENTRIES = [
  'GraphiteDawnCache',
  'ShaderCache',
  'GrShaderCache',
  'component_crx_cache',
];
const CHROME_PROFILE_TRANSIENT_ENTRIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  // 注意：不清理 Sessions 目录——Chrome 需要它来恢复上次会话并保留 session cookie。
  // 千牛 (myseller.taobao.com) 的登录态依赖 session cookie，清掉 Sessions 会导致
  // Chrome 视为全新启动并清除所有 session cookie，每次重启都要重新登录。
  'Session Storage',
  'Service Worker',
  'Platform Notifications',
  'Network Persistent State',
];
const TAMPERMONKEY_CANONICAL_WEBREQUEST_EVENTS = [
  'webRequest.onBeforeRequest/s1',
  'webRequest.onHeadersReceived/s2',
  'webRequest.onResponseStarted/s3',
  'webRequest.onErrorOccurred/s4',
];

import type { ChildProcess, SpawnOptions } from 'child_process';

interface ClientConfig {
  watch: boolean;
  cdpPort: number;
  syncInterval: number;
  chromeProfileName: string;
  chromeProfileDirectory: string;
  chromeUserDataDir: string;
  chromeMonitorIntervalMs: number;
  goofishUrl: string;
  qianniuUrl: string;
  runtimeLogPath: string;
  chromeProxyDisabled: boolean;
  chromeProxyServer: string;
  chromeProxyScheme: string;
  chromeProxyUsername: string;
  chromeProxyPassword: string;
  chromeProxyBypassList: string;
  chromeProxyExtensionDir: string;
  chromeClearTransientDataOnStart: boolean;
  chromeStartTimeoutMs: number;
  chromeRepairTampermonkeyWebRequestOnStart: boolean;
  tampermonkeyWebRequestEventThreshold: number;
  serverUrl: string;
  browserBridgeHost: string;
  browserWssPort: number;
  clientId: string;
  clientSecret: string;
  accountId: string;
  clientName: string;
}

interface ChromeProfile {
  profileDirectory: string;
  displayName: string;
}

interface NormalizedProxy {
  serverArg: string;
  host: string;
  port: number;
  scheme: string;
}

interface ProxyArgs {
  args: string[];
  extensionDirs: string[];
  logMessage: string | null;
}

interface CompactResult {
  changed: boolean;
  removedKeys: number;
  beforeCount: number;
  afterCount: number;
}

const children: ChildProcess[] = [];
let shuttingDown = false;
let runtimeLogStream: NodeJS.WritableStream | null = null;
let chromeWatchTimer: ReturnType<typeof setInterval> | null = null;
let chromeEnsuring = false;
let browserBridgeHandle: { httpsServer: any; wss: any } | null = null;
let browserBridgeTlsSpkiHash = '';
let browserHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let browserRpcSocket: any = null;
let activeInitialCrawlNonce: string | null = null;
let lastHandledInitialCrawlNonce: string | null = null;
let initialCrawlBusy = false;
let cdpEvalSocket: any = null;
let cdpEvalSocketUrl = '';
let cdpEvalMessageId = 0;

// ── 基础设施 ──────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  return {
    watch: argv.includes('--watch'),
  };
}

function writeToStreamSafely(stream: NodeJS.WritableStream | null, chunk: string | Buffer) {
  if (!stream || stream.destroyed || stream.writableEnded === true || stream.writable === false) {
    return;
  }

  try {
    stream.write(chunk);
  } catch (_) {
    // 退出阶段允许日志丢失，避免因为收尾输出把整个启动器打崩。
  }
}

function log(message: string) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [client] ${message}\n`;
  process.stdout.write(line);
  writeToStreamSafely(runtimeLogStream, line);
}

function encodeHeaderValue(value: any) {
  return encodeURIComponent(String(value || ''));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findGoofishTabWebSocketUrl(config: ClientConfig) {
  const response = await fetch(`http://127.0.0.1:${config.cdpPort}/json`);
  if (!response.ok) {
    throw new Error(`CDP not available at port ${config.cdpPort}`);
  }

  const tabs = await response.json();
  const tab = tabs.find((item: any) => item.url && item.url.includes('goofish.com/im') && item.type === 'page');
  if (!tab) {
    throw new Error('goofish.com/im tab not found');
  }

  return tab.webSocketDebuggerUrl || `ws://127.0.0.1:${config.cdpPort}/devtools/page/${tab.id}`;
}

async function ensureCdpEvalSocket(config: ClientConfig) {
  const socketUrl = await findGoofishTabWebSocketUrl(config);
  if (cdpEvalSocket && cdpEvalSocket.readyState === WebSocket.OPEN && cdpEvalSocketUrl === socketUrl) {
    return cdpEvalSocket;
  }

  if (cdpEvalSocket) {
    try {
      cdpEvalSocket.close();
    } catch (_) {
      // ignore stale socket close errors
    }
    cdpEvalSocket = null;
  }

  cdpEvalSocketUrl = socketUrl;
  cdpEvalSocket = await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch (_) {
        // ignore timeout close errors
      }
      reject(new Error('CDP WebSocket connect timeout'));
    }, 10000);

    socket.on('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('error', (error: any) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      if (cdpEvalSocket === socket) {
        cdpEvalSocket = null;
      }
    });
  });

  return cdpEvalSocket;
}

async function evalInGoofishTab(config: ClientConfig, expression: string, timeoutMs = 120000) {
  const socket = await ensureCdpEvalSocket(config);
  const requestId = ++cdpEvalMessageId;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.removeListener('message', onMessage);
      reject(new Error('CDP eval timeout'));
    }, timeoutMs);

    const onMessage = (raw: any) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      if (message.id !== requestId) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.removeListener('message', onMessage);

      if (message.result?.exceptionDetails) {
        const details = message.result.exceptionDetails;
        const description = details.exception?.description || details.text || 'CDP eval error';
        reject(new Error(description));
        return;
      }

      resolve(message.result?.result?.value);
    };

    socket.on('message', onMessage);
    socket.send(JSON.stringify({
      id: requestId,
      method: 'Runtime.evaluate',
      params: {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    }));
  });
}

function setupLogStreams(config: ClientConfig) {
  runtimeLogStream = fs.createWriteStream(config.runtimeLogPath, { flags: 'a' });
}

function readLocalJsonConfig(filePath: string): Record<string, any> {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function attachChildOutput(child: ChildProcess, targets: NodeJS.WritableStream[]) {
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      for (const stream of targets) {
        writeToStreamSafely(stream, chunk);
      }
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      for (const stream of targets) {
        writeToStreamSafely(stream, chunk);
      }
    });
  }
}

function spawnChild(
  command: string,
  args: string[],
  options: SpawnOptions & { logTargets?: NodeJS.WritableStream[] } = {}
): ChildProcess {
  const { logTargets = [], ...spawnOptions } = options;
  const child = spawn(command, args, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    ...spawnOptions,
  });

  attachChildOutput(child, logTargets);
  children.push(child);
  child.once('exit', (code: number | null, signal: string | null) => {
    if (!shuttingDown && code && code !== 0) {
      log(`${path.basename(command)} 退出异常: code=${code} signal=${signal || 'none'}`);
    }
  });

  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await sleep(500);
  }
  return false;
}

// ── Chrome 启动 ───────────────────────────────────────────────────

function getChromeLaunchBase(): { command: string; baseArgs: string[] } {
  switch (process.platform) {
    case 'darwin':
      return {
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        baseArgs: [],
      };
    case 'win32':
      return {
        command: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        baseArgs: [],
      };
    default:
      return {
        command: 'google-chrome',
        baseArgs: [],
      };
  }
}

function normalizeChromeProxyServer(
  rawProxyServer: string,
  defaultScheme: string
): NormalizedProxy | null {
  if (!rawProxyServer) {
    return null;
  }

  const withScheme = /^[a-z]+:\/\//i.test(rawProxyServer)
    ? rawProxyServer
    : `${defaultScheme}://${rawProxyServer}`;
  const url = new URL(withScheme);

  return {
    serverArg: `${url.protocol}//${url.host}`,
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    scheme: url.protocol.replace(':', ''),
  };
}

function hasChromeProxy(config: ClientConfig): boolean {
  return !!config.chromeProxyServer;
}

function ensureChromeProxyExtension(config: ClientConfig): string | null {
  if (!config.chromeProxyUsername || !config.chromeProxyPassword) {
    return null;
  }

  const normalizedProxy = normalizeChromeProxyServer(
    config.chromeProxyServer,
    config.chromeProxyScheme
  );
  if (!normalizedProxy) {
    return null;
  }

  fs.mkdirSync(config.chromeProxyExtensionDir, { recursive: true });

  const manifestPath = path.join(config.chromeProxyExtensionDir, 'manifest.json');
  const backgroundPath = path.join(config.chromeProxyExtensionDir, 'background.js');
  const manifest = {
    manifest_version: 3,
    name: 'Goofish Proxy Auth Helper',
    version: '1.0.0',
    description: 'Provide proxy authentication for the project Chrome instance.',
    permissions: ['webRequest', 'webRequestAuthProvider'],
    host_permissions: ['<all_urls>'],
    background: {
      service_worker: 'background.js',
    },
  };
  const background = `'use strict';

const proxyConfig = ${JSON.stringify({
    host: normalizedProxy.host,
    port: normalizedProxy.port,
    username: config.chromeProxyUsername,
    password: config.chromeProxyPassword,
  }, null, 2)};

function shouldHandleProxyAuth(details) {
  return !!details.isProxy;
}

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!shouldHandleProxyAuth(details)) {
      callback();
      return;
    }

    callback({
      authCredentials: {
        username: proxyConfig.username,
        password: proxyConfig.password,
      },
    });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);
`;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(backgroundPath, background);

  return config.chromeProxyExtensionDir;
}

function buildChromeProxyArgs(config: ClientConfig): ProxyArgs {
  if (!hasChromeProxy(config)) {
    return { args: [], extensionDirs: [], logMessage: null };
  }

  const normalizedProxy = normalizeChromeProxyServer(
    config.chromeProxyServer,
    config.chromeProxyScheme
  );
  if (!normalizedProxy) {
    return { args: [], extensionDirs: [], logMessage: null };
  }

  const args = [`--proxy-server=${normalizedProxy.serverArg}`];
  const extensionDirs: string[] = [];
  if (config.chromeProxyBypassList) {
    args.push(`--proxy-bypass-list=${config.chromeProxyBypassList}`);
  }

  const proxyExtensionDir = ensureChromeProxyExtension(config);
  if (proxyExtensionDir) {
    extensionDirs.push(proxyExtensionDir);
  }

  return {
    args,
    extensionDirs,
    logMessage: `启用 Chrome 代理 ${normalizedProxy.serverArg}${proxyExtensionDir ? '（含认证扩展）' : ''}`,
  };
}

function resolveChromeProfile(userDataRoot: string, profileName: string): ChromeProfile {
  const localStatePath = path.join(userDataRoot, 'Local State');
  const raw = fs.readFileSync(localStatePath, 'utf8');
  const localState = JSON.parse(raw);
  const infoCache = localState?.profile?.info_cache || {};

  for (const [profileDirectory, profileInfo] of Object.entries(infoCache)) {
    if (profileDirectory === profileName || profileInfo?.name === profileName) {
      return {
        profileDirectory,
        displayName: profileInfo?.name || profileName,
      };
    }
  }

  throw new Error(`未找到名为 "${profileName}" 的 Chrome profile`);
}

function ensureChromeUserDataDir(userDataRoot: string) {
  fs.mkdirSync(userDataRoot, { recursive: true });
}

function removePathIfExists(targetPath: string): boolean {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return false;
  }

  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 2,
    retryDelay: 50,
  });
  return true;
}

function clearChromeSingletonArtifacts(userDataRoot: string): string[] {
  const removed: string[] = [];
  for (const entry of CHROME_SINGLETON_ARTIFACTS) {
    const targetPath = path.join(userDataRoot, entry);
    if (removePathIfExists(targetPath)) {
      removed.push(entry);
    }
  }
  return removed;
}

function clearChromeTransientData(config: ClientConfig, profile: ChromeProfile) {
  const removed = clearChromeSingletonArtifacts(config.chromeUserDataDir);
  if (!config.chromeClearTransientDataOnStart) {
    if (removed.length > 0) {
      log(`启动前清理 Chrome 残留锁文件: ${removed.join(', ')}`);
    }
    return;
  }

  for (const entry of CHROME_ROOT_TRANSIENT_ENTRIES) {
    const targetPath = path.join(config.chromeUserDataDir, entry);
    if (removePathIfExists(targetPath)) {
      removed.push(entry);
    }
  }

  const profileRoot = path.join(config.chromeUserDataDir, profile.profileDirectory);
  for (const entry of CHROME_PROFILE_TRANSIENT_ENTRIES) {
    const targetPath = path.join(profileRoot, entry);
    if (removePathIfExists(targetPath)) {
      removed.push(path.join(profile.profileDirectory, entry));
    }
  }

  if (removed.length > 0) {
    log(`启动前清理 Chrome 瞬态数据: ${removed.join(', ')}`);
  }
}

// ── Tampermonkey 修复 ─────────────────────────────────────────────

function isTampermonkeyExtensionSetting(extensionSetting: Record<string, any> = {}): boolean {
  const manifest = extensionSetting.manifest || {};
  const nameText = [
    manifest.name,
    manifest.short_name,
    manifest.description,
  ]
    .filter(Boolean)
    .join(' ');

  if (/tampermonkey|篡改猴/u.test(nameText)) {
    return true;
  }

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const serviceWorkerEvents = Array.isArray(extensionSetting.serviceworkerevents)
    ? extensionSetting.serviceworkerevents
    : [];

  return permissions.includes('webRequestBlocking')
    && permissions.includes('userScripts')
    && serviceWorkerEvents.includes('webRequest.onBeforeRequest/s1')
    && serviceWorkerEvents.includes('webRequest.onResponseStarted/s3');
}

function getServiceWorkerEventBaseKey(eventKey: string): string {
  return String(eventKey || '').replace(/\/s\d+$/, '');
}

function selectCanonicalFilteredEventValue(
  entries: { key: string; value: any }[],
  preferredKey: string
): any[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const exactMatch = entries.find((entry) => entry.key === preferredKey);
  if (exactMatch) {
    return exactMatch.value;
  }

  const populatedEntry = entries.find(
    (entry) => Array.isArray(entry.value) && entry.value.length > 0
  );
  if (populatedEntry) {
    return populatedEntry.value;
  }

  const shortestKeyEntry = [...entries].sort((left, right) => {
    return left.key.length - right.key.length || left.key.localeCompare(right.key);
  })[0];
  return shortestKeyEntry.value;
}

function writeJsonFileAtomically(filePath: string, payload: any) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const fileMode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o600;
  fs.writeFileSync(tempPath, JSON.stringify(payload));
  fs.chmodSync(tempPath, fileMode);
  fs.renameSync(tempPath, filePath);
}

function buildBackupTimestamp(): string {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];
  return parts.join('');
}

function backupFileBeforeRepair(filePath: string): string {
  const backupPath = `${filePath}.bak.tm-webrequest-repair.${buildBackupTimestamp()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function compactFilteredWebRequestEvents(
  extensionSetting: Record<string, any>,
  threshold: number
): CompactResult {
  const filteredEvents = extensionSetting?.filtered_service_worker_events;
  if (!filteredEvents || typeof filteredEvents !== 'object' || Array.isArray(filteredEvents)) {
    return { changed: false, removedKeys: 0, beforeCount: 0, afterCount: 0 };
  }

  const eventKeys = Object.keys(filteredEvents);
  const webRequestKeys = eventKeys.filter((key) => key.startsWith('webRequest.'));
  if (webRequestKeys.length <= threshold) {
    return {
      changed: false,
      removedKeys: 0,
      beforeCount: webRequestKeys.length,
      afterCount: webRequestKeys.length,
    };
  }

  const groupedEntries = new Map<string, { key: string; value: any }[]>();
  for (const eventKey of webRequestKeys) {
    const baseKey = getServiceWorkerEventBaseKey(eventKey);
    if (!groupedEntries.has(baseKey)) {
      groupedEntries.set(baseKey, []);
    }
    groupedEntries.get(baseKey).push({
      key: eventKey,
      value: filteredEvents[eventKey],
    });
  }

  const nextFilteredEvents: Record<string, any> = {};
  for (const [eventKey, value] of Object.entries(filteredEvents)) {
    if (!eventKey.startsWith('webRequest.')) {
      nextFilteredEvents[eventKey] = value;
    }
  }

  const canonicalKeys = Array.isArray(extensionSetting.serviceworkerevents)
    ? extensionSetting.serviceworkerevents.filter((eventKey) => eventKey.startsWith('webRequest.'))
    : TAMPERMONKEY_CANONICAL_WEBREQUEST_EVENTS;
  const usedBaseKeys = new Set<string>();

  for (const canonicalKey of canonicalKeys) {
    const baseKey = getServiceWorkerEventBaseKey(canonicalKey);
    const entries = groupedEntries.get(baseKey);
    if (!entries || entries.length === 0) {
      continue;
    }
    nextFilteredEvents[canonicalKey] = selectCanonicalFilteredEventValue(entries, canonicalKey);
    usedBaseKeys.add(baseKey);
  }

  for (const [baseKey, entries] of groupedEntries.entries()) {
    if (usedBaseKeys.has(baseKey) || entries.length === 0) {
      continue;
    }
    const fallbackKey = [...entries].sort((left, right) => {
      return left.key.length - right.key.length || left.key.localeCompare(right.key);
    })[0].key;
    nextFilteredEvents[fallbackKey] = selectCanonicalFilteredEventValue(entries, fallbackKey);
  }

  const nextWebRequestCount = Object.keys(nextFilteredEvents).filter((key) => key.startsWith('webRequest.')).length;
  if (nextWebRequestCount >= webRequestKeys.length) {
    return {
      changed: false,
      removedKeys: 0,
      beforeCount: webRequestKeys.length,
      afterCount: webRequestKeys.length,
    };
  }

  extensionSetting.filtered_service_worker_events = nextFilteredEvents;
  return {
    changed: true,
    removedKeys: webRequestKeys.length - nextWebRequestCount,
    beforeCount: webRequestKeys.length,
    afterCount: nextWebRequestCount,
  };
}

function clearSecurePreferenceProtectionForExtension(
  securePreferences: Record<string, any>,
  extensionId: string
) {
  const extensionProtection = securePreferences?.protection?.macs?.extensions;
  if (extensionProtection?.settings && extensionId in extensionProtection.settings) {
    delete extensionProtection.settings[extensionId];
  }
  if (
    extensionProtection?.settings_encrypted_hash
    && extensionId in extensionProtection.settings_encrypted_hash
  ) {
    delete extensionProtection.settings_encrypted_hash[extensionId];
  }
  if (securePreferences?.protection?.super_mac) {
    delete securePreferences.protection.super_mac;
  }
}

function repairTampermonkeyWebRequestExplosion(config: ClientConfig, profile: ChromeProfile) {
  if (!config.chromeRepairTampermonkeyWebRequestOnStart) {
    return;
  }

  const securePreferencesPath = path.join(
    config.chromeUserDataDir,
    profile.profileDirectory,
    'Secure Preferences'
  );
  if (!fs.existsSync(securePreferencesPath)) {
    return;
  }

  let securePreferences;
  try {
    securePreferences = JSON.parse(fs.readFileSync(securePreferencesPath, 'utf8'));
  } catch (error) {
    log(`读取 Secure Preferences 失败，跳过 Tampermonkey 修复: ${error.message}`);
    return;
  }

  const extensionSettings = securePreferences?.extensions?.settings;
  if (!extensionSettings || typeof extensionSettings !== 'object') {
    return;
  }

  const repairSummaries: {
    extensionId: string;
    removedKeys: number;
    beforeCount: number;
    afterCount: number;
    name: string;
  }[] = [];
  for (const [extensionId, extensionSetting] of Object.entries(extensionSettings)) {
    if (!isTampermonkeyExtensionSetting(extensionSetting)) {
      continue;
    }

    const result = compactFilteredWebRequestEvents(
      extensionSetting,
      config.tampermonkeyWebRequestEventThreshold
    );
    if (!result.changed) {
      continue;
    }

    clearSecurePreferenceProtectionForExtension(securePreferences, extensionId);
    repairSummaries.push({
      extensionId,
      removedKeys: result.removedKeys,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      name: extensionSetting?.manifest?.name || extensionId,
    });
  }

  if (repairSummaries.length === 0) {
    return;
  }

  const backupPath = backupFileBeforeRepair(securePreferencesPath);
  writeJsonFileAtomically(securePreferencesPath, securePreferences);

  for (const summary of repairSummaries) {
    log(
      `启动前修复 ${summary.name} (${summary.extensionId}) 的 webRequest 子事件膨胀: `
      + `${summary.beforeCount} -> ${summary.afterCount}，移除 ${summary.removedKeys} 个重复键；备份 ${backupPath}`
    );
  }
}

// ── Chrome 生命周期 ───────────────────────────────────────────────

function terminateChromeChild(child: ChildProcess | null, reason: string) {
  if (!child || child.killed) {
    return;
  }

  log(reason);
  try {
    child.kill('SIGTERM');
  } catch (_) {
    // 启动失败清理阶段忽略 kill 异常
  }
}

function getChromeProfile(config: ClientConfig): ChromeProfile {
  if (config.chromeProfileDirectory) {
    return {
      profileDirectory: config.chromeProfileDirectory,
      displayName: config.chromeProfileName || config.chromeProfileDirectory,
    };
  }

  return resolveChromeProfile(config.chromeUserDataDir, config.chromeProfileName);
}

function buildChromeStartupUrls(config: ClientConfig): string[] {
  const urls = [
    config.goofishUrl,
    config.qianniuUrl,
  ]
    .map((url) => String(url || '').trim())
    .filter(Boolean);

  return [...new Set(urls)];
}

function hasPreviousSessionData(chromeUserDataDir: string, profileDirectory: string): boolean {
  const sessionsDir = path.join(chromeUserDataDir, profileDirectory, 'Sessions');
  if (!fs.existsSync(sessionsDir)) {
    return false;
  }

  try {
    const entries = fs.readdirSync(sessionsDir);
    return entries.some((name) => name.startsWith('Session_') || name.startsWith('Tabs_'));
  } catch (_) {
    return false;
  }
}

async function launchChromeAttempt(config: ClientConfig) {
  ensureChromeUserDataDir(config.chromeUserDataDir);
  const profile = getChromeProfile(config);
  clearChromeTransientData(config, profile);
  repairTampermonkeyWebRequestExplosion(config, profile);
  const proxyArgs = buildChromeProxyArgs(config);

  const canRestore = hasPreviousSessionData(config.chromeUserDataDir, profile.profileDirectory);
  const startupUrls = canRestore ? [] : buildChromeStartupUrls(config);

  const launchBase = getChromeLaunchBase();
  const launchArgs = [
    ...launchBase.baseArgs,
    '--no-first-run',
    ...buildChromeTlsArgs(browserBridgeTlsSpkiHash),
    ...(canRestore ? ['--restore-last-session'] : []),
    ...proxyArgs.args,
    ...(proxyArgs.extensionDirs.length > 0 ? [`--load-extension=${proxyArgs.extensionDirs.join(',')}`] : []),
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.chromeUserDataDir}`,
    `--profile-directory=${profile.profileDirectory}`,
    ...startupUrls
  ];

  log(
    `拉起 Chrome profile "${profile.displayName}" (${profile.profileDirectory})，用户数据目录 ${config.chromeUserDataDir}，监听 ${config.cdpPort}`
  );
  log(canRestore ? '恢复上次会话（保留 session cookie）' : `启动页: ${buildChromeStartupUrls(config).join(' , ')}`);
  if (proxyArgs.logMessage) {
    log(proxyArgs.logMessage);
  }
  const child = spawnChild(launchBase.command, launchArgs, {
    detached: process.platform !== 'win32',
    logTargets: [runtimeLogStream],
  });

  const ready = await waitForPort(config.cdpPort, config.chromeStartTimeoutMs);
  return { child, profile, ready };
}

async function ensureChromeDebugging(config: ClientConfig): Promise<void> {
  const alreadyListening = await isPortOpen(config.cdpPort);
  if (alreadyListening) {
    log(`检测到 Chrome 已监听 ${config.cdpPort}，跳过重复拉起`);
    return;
  }

  const launchAttempt = await launchChromeAttempt(config);
  if (launchAttempt.ready) {
    return;
  }

  terminateChromeChild(
    launchAttempt.child,
    `Chrome 启动超时，${config.chromeStartTimeoutMs}ms 内未开放 ${config.cdpPort}，准备结束当前实例`
  );
  throw new Error(`Chrome 未在 ${config.chromeStartTimeoutMs}ms 内开放 ${config.cdpPort} 调试端口`);
}

function startChromeWatchdog(config: ClientConfig) {
  if (chromeWatchTimer) {
    clearInterval(chromeWatchTimer);
  }

  chromeWatchTimer = setInterval(async () => {
    if (shuttingDown || chromeEnsuring) {
      return;
    }

    const alive = await isPortOpen(config.cdpPort);
    if (alive) {
      return;
    }

    chromeEnsuring = true;
    try {
      log(
        `检测到 Chrome 调试端口 ${config.cdpPort} 已关闭，准备使用 ${config.chromeUserDataDir} 自动恢复浏览器`
      );
      await ensureChromeDebugging(config);
    } catch (error) {
      log(`自动恢复 Chrome 失败: ${error.message}`);
    } finally {
      chromeEnsuring = false;
    }
  }, config.chromeMonitorIntervalMs);
}

// ── 本地 Browser Bridge ──────────────────────────────────────────

function buildLocalBrowserOrigin(config: ClientConfig): string {
  return `https://${config.browserBridgeHost}:${config.browserWssPort}`;
}

function ensureBrowserBridgeTlsMaterial() {
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

    const result = spawnSync('openssl', opensslArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      throw new Error(
        `openssl 生成 localhost bridge 证书失败：${(result.stderr || result.stdout || '').trim() || 'unknown error'}`
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

function sendBrowserRpcResponse(socket: any, id: string | number | null, message: Record<string, any>) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: 'rpc-response',
    id,
    ...message,
  }));
}

function stripOkEnvelope(payload: any) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.ok !== true) {
    return payload;
  }

  const { ok, ...rest } = payload;
  return rest;
}

async function readJsonResponse(response: any) {
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

async function forwardBrowserActionToServer(config: ClientConfig, action: string, payload: Record<string, any> = {}) {
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

async function handleBrowserRpcAction(config: ClientConfig, action: string, payload: Record<string, any> = {}) {
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

function startBrowserBridgeServer(config: ClientConfig) {
  const tlsMaterial = ensureBrowserBridgeTlsMaterial();
  browserBridgeTlsSpkiHash = computeCertificateSpkiHash(tlsMaterial.certPath);
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
    browserRpcSocket = socket;

    socket.on('close', () => {
      if (browserRpcSocket === socket) {
        browserRpcSocket = null;
      }
    });

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
    if (tlsMaterial.generated) {
      log(`生成本地 bridge 证书: ${tlsMaterial.certPath}`);
      log(`生成本地 bridge 私钥: ${tlsMaterial.keyPath}`);
    }
    if (browserBridgeTlsSpkiHash) {
      log('已为项目专用 Chrome 注入本地 bridge 证书 SPKI allowlist');
    }
  });

  return { httpsServer, wss };
}

async function runInitialCrawl(config: ClientConfig, nonce: string, sessionCount?: number) {
  if (!nonce || initialCrawlBusy || nonce === lastHandledInitialCrawlNonce || nonce === activeInitialCrawlNonce) {
    return;
  }

  initialCrawlBusy = true;
  activeInitialCrawlNonce = nonce;
  const limit = Number(sessionCount) > 0 ? Number(sessionCount) : DEFAULT_INITIAL_CRAWL_SESSION_COUNT;

  try {
    log(`收到 initial_crawl 指令: ${nonce}，开始执行，limit=${limit}`);
    const expression = `(() => {
      const runner = window.__tamperfishRunInitialConversationSync;
      if (typeof runner !== 'function') {
        throw new Error('tamperfish initial crawl runner is not ready');
      }
      return runner(${JSON.stringify(nonce)}, ${JSON.stringify(limit)}).then(() => ({ ok: true }));
    })()`;

    await evalInGoofishTab(config, expression, 10 * 60 * 1000);

    lastHandledInitialCrawlNonce = nonce;
    await forwardBrowserActionToServer(config, 'browser.heartbeat', {
      crawlerEnabled: false,
      initialCrawlNonceHandled: nonce,
    }).catch(() => null);
    log(`initial_crawl 执行完成: ${nonce}`);
  } catch (error) {
    log(`initial_crawl 执行失败: ${nonce} ${error.message || error}`);
  } finally {
    activeInitialCrawlNonce = null;
    initialCrawlBusy = false;
  }
}

async function syncBrowserHeartbeat(config: ClientConfig) {
  try {
    const payload = await forwardBrowserActionToServer(config, 'browser.heartbeat', {
      crawlerEnabled: false,
      initialCrawlNonceHandled: lastHandledInitialCrawlNonce,
    });

    if (
      payload?.initialCrawlNonce &&
      payload.initialCrawlNonce !== lastHandledInitialCrawlNonce &&
      payload.initialCrawlNonce !== activeInitialCrawlNonce &&
      !initialCrawlBusy
    ) {
      await runInitialCrawl(config, payload.initialCrawlNonce, payload.initialCrawlSessionCount);
    }
  } catch (error) {
    log(`browser heartbeat 失败: ${error.message || error}`);
  }
}

function startBrowserHeartbeatLoop(config: ClientConfig) {
  if (browserHeartbeatTimer) {
    clearInterval(browserHeartbeatTimer);
  }

  syncBrowserHeartbeat(config);
  browserHeartbeatTimer = setInterval(() => {
    syncBrowserHeartbeat(config);
  }, DEFAULT_BROWSER_HEARTBEAT_INTERVAL_MS);
}

// ── 退出处理 ──────────────────────────────────────────────────────

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，准备停止所有子进程`);

  if (chromeWatchTimer) {
    clearInterval(chromeWatchTimer);
    chromeWatchTimer = null;
  }

  if (browserHeartbeatTimer) {
    clearInterval(browserHeartbeatTimer);
    browserHeartbeatTimer = null;
  }

  if (cdpEvalSocket) {
    try {
      cdpEvalSocket.close();
    } catch (_) {
      // ignore close errors during shutdown
    }
    cdpEvalSocket = null;
  }

  if (browserBridgeHandle) {
    try {
      browserBridgeHandle.wss.close();
      browserBridgeHandle.httpsServer.close();
    } catch (_) {
      // 忽略关闭 browser bridge 时的异常
    }
    browserBridgeHandle = null;
  }

  for (const child of children) {
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch (_) {
        // 忽略清理阶段的个别失败
      }
    }
  }

  if (runtimeLogStream) {
    runtimeLogStream.end();
  }

  setTimeout(() => process.exit(0), 500);
}

// ── 主入口 ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chromeProxyConfigPath =
    process.env.CHROME_PROXY_CONFIG_PATH || DEFAULT_CHROME_PROXY_CONFIG_PATH;
  const localChromeProxyConfig = readLocalJsonConfig(chromeProxyConfigPath);
  const chromeProxyDisabled = process.env.CHROME_PROXY_DISABLED === '1';
  const chromeClearTransientDataEnv = process.env.CHROME_CLEAR_TRANSIENT_DATA_ON_START;
  const rawTampermonkeyThreshold = Number(process.env.CHROME_TAMPERMONKEY_WEBREQUEST_EVENT_THRESHOLD);
  const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:3210';
  const clientId = process.env.CLIENT_ID || 'legacy-client-1';
  const clientSecret = process.env.CLIENT_SECRET || '';
  const accountId = process.env.ACCOUNT_ID || 'default';
  const clientName = process.env.CLIENT_NAME || '';

  const config: ClientConfig = {
    watch: args.watch,
    cdpPort: Number(process.env.CDP_PORT || DEFAULT_CDP_PORT),
    syncInterval: Number(process.env.SYNC_INTERVAL || DEFAULT_SYNC_INTERVAL),
    chromeProfileName: process.env.CHROME_PROFILE_NAME || DEFAULT_PROFILE_NAME,
    chromeProfileDirectory:
      process.env.CHROME_PROFILE_DIRECTORY ||
      (process.env.CHROME_USER_DATA_DIR ? '' : DEFAULT_CHROME_PROFILE_DIRECTORY),
    chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || DEFAULT_CHROME_USER_DATA_DIR,
    chromeMonitorIntervalMs: Number(
      process.env.CHROME_MONITOR_INTERVAL_MS || DEFAULT_CHROME_MONITOR_INTERVAL_MS
    ),
    goofishUrl: process.env.GOOFISH_URL || DEFAULT_GOOFISH_URL,
    qianniuUrl: process.env.QIANNIU_URL || DEFAULT_QIANNIU_URL,
    runtimeLogPath: process.env.RUNTIME_LOG_PATH || DEFAULT_RUNTIME_LOG_PATH,
    chromeProxyDisabled,
    chromeProxyServer:
      chromeProxyDisabled ? '' : process.env.CHROME_PROXY_SERVER || localChromeProxyConfig.proxyServer || '',
    chromeProxyScheme:
      process.env.CHROME_PROXY_SCHEME ||
      localChromeProxyConfig.proxyScheme ||
      DEFAULT_CHROME_PROXY_SCHEME,
    chromeProxyUsername:
      chromeProxyDisabled ? '' : process.env.CHROME_PROXY_USERNAME || localChromeProxyConfig.proxyUsername || '',
    chromeProxyPassword:
      chromeProxyDisabled ? '' : process.env.CHROME_PROXY_PASSWORD || localChromeProxyConfig.proxyPassword || '',
    chromeProxyBypassList:
      process.env.CHROME_PROXY_BYPASS_LIST ||
      localChromeProxyConfig.proxyBypassList ||
      DEFAULT_CHROME_PROXY_BYPASS_LIST,
    chromeProxyExtensionDir: DEFAULT_CHROME_PROXY_EXTENSION_DIR,
    chromeClearTransientDataOnStart:
      chromeClearTransientDataEnv === '0'
        ? false
        : chromeClearTransientDataEnv === '1'
        ? true
        : DEFAULT_CHROME_CLEAR_TRANSIENT_DATA_ON_START,
    chromeStartTimeoutMs: Number(process.env.CHROME_START_TIMEOUT_MS || DEFAULT_CHROME_START_TIMEOUT_MS),
    chromeRepairTampermonkeyWebRequestOnStart:
      process.env.CHROME_REPAIR_TAMPERMONKEY_WEBREQUEST_ON_START === '0'
        ? false
        : DEFAULT_CHROME_REPAIR_TAMPERMONKEY_WEBREQUEST_ON_START,
    tampermonkeyWebRequestEventThreshold:
      Number.isFinite(rawTampermonkeyThreshold) && rawTampermonkeyThreshold > 0
        ? rawTampermonkeyThreshold
        : DEFAULT_TAMPERMONKEY_WEBREQUEST_EVENT_THRESHOLD,
    serverUrl,
    browserBridgeHost: process.env.BROWSER_BIND_HOST || DEFAULT_BROWSER_BRIDGE_HOST,
    browserWssPort: Number(process.env.BROWSER_WSS_PORT || DEFAULT_BROWSER_WSS_PORT),
    clientId,
    clientSecret,
    accountId,
    clientName,
  };

  setupLogStreams(config);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (config.chromeProxyDisabled) {
    log('已通过 CHROME_PROXY_DISABLED=1 禁用项目 Chrome 代理');
  }

  // Register this client with the server on startup
  try {
    const regResp = await fetch(`${config.serverUrl}/api/clients/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': encodeHeaderValue(config.clientId),
        'X-Client-Secret': encodeHeaderValue(config.clientSecret),
      },
      body: JSON.stringify({
        clientId: config.clientId,
        accountId: config.accountId,
        clientName: config.clientName,
        clientSecret: config.clientSecret,
        capabilities: ['crawler', 'qianniu'],
      }),
    });
    if (regResp.ok) {
      log(`已向 server 注册 client: ${config.clientId} (account: ${config.accountId})`);
    } else {
      const body = await regResp.text();
      log(`client 注册失败 (${regResp.status}): ${body}`);
    }
  } catch (err) {
    log(`client 注册请求失败: ${err.message}（server 可能离线，继续启动）`);
  }

  browserBridgeHandle = startBrowserBridgeServer(config);
  await ensureChromeDebugging(config);
  startChromeWatchdog(config);
  startBrowserHeartbeatLoop(config);

  log(`启动 sync.ts，连接 CDP ${config.cdpPort}，同步到 ${serverUrl}，client: ${config.clientId}`);
  spawnChild(process.execPath, ['sync.ts'], {
    env: {
      ...process.env,
      SERVER_URL: serverUrl,
      CDP_PORT: String(config.cdpPort),
      SYNC_INTERVAL: String(config.syncInterval),
      CLIENT_ID: config.clientId,
      CLIENT_SECRET: config.clientSecret,
      ACCOUNT_ID: config.accountId,
    },
    logTargets: [runtimeLogStream],
  });
}

main().catch((err) => {
  console.error(`[client] 启动失败: ${err.message}`);
  process.exit(1);
});
