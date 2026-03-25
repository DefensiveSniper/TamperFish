'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

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
const DEFAULT_BROWSER_WSS_PORT = 3211;
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

const children = [];
let shuttingDown = false;
let runtimeLogStream = null;
let chromeWatchTimer = null;
let chromeEnsuring = false;

// ── 基础设施 ──────────────────────────────────────────────────────

function parseArgs(argv) {
  return {
    watch: argv.includes('--watch'),
  };
}

function writeToStreamSafely(stream, chunk) {
  if (!stream || stream.destroyed || stream.writableEnded === true || stream.writable === false) {
    return;
  }

  try {
    stream.write(chunk);
  } catch (_) {
    // 退出阶段允许日志丢失，避免因为收尾输出把整个启动器打崩。
  }
}

function log(message) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [client] ${message}\n`;
  process.stdout.write(line);
  writeToStreamSafely(runtimeLogStream, line);
}

function setupLogStreams(config) {
  runtimeLogStream = fs.createWriteStream(config.runtimeLogPath, { flags: 'a' });
}

function readLocalJsonConfig(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function attachChildOutput(child, targets) {
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

function spawnChild(command, args, options = {}) {
  const { logTargets = [], ...spawnOptions } = options;
  const child = spawn(command, args, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    ...spawnOptions,
  });

  attachChildOutput(child, logTargets);
  children.push(child);
  child.once('exit', (code, signal) => {
    if (!shuttingDown && code && code !== 0) {
      log(`${path.basename(command)} 退出异常: code=${code} signal=${signal || 'none'}`);
    }
  });

  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await sleep(500);
  }
  return false;
}

// ── Chrome 启动 ───────────────────────────────────────────────────

function getChromeLaunchBase() {
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

function normalizeChromeProxyServer(rawProxyServer, defaultScheme) {
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

function hasChromeProxy(config) {
  return !!config.chromeProxyServer;
}

function ensureChromeProxyExtension(config) {
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

function buildChromeProxyArgs(config) {
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
  const extensionDirs = [];
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

function resolveChromeProfile(userDataRoot, profileName) {
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

function ensureChromeUserDataDir(userDataRoot) {
  fs.mkdirSync(userDataRoot, { recursive: true });
}

function removePathIfExists(targetPath) {
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

function clearChromeSingletonArtifacts(userDataRoot) {
  const removed = [];
  for (const entry of CHROME_SINGLETON_ARTIFACTS) {
    const targetPath = path.join(userDataRoot, entry);
    if (removePathIfExists(targetPath)) {
      removed.push(entry);
    }
  }
  return removed;
}

function clearChromeTransientData(config, profile) {
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

function isTampermonkeyExtensionSetting(extensionSetting = {}) {
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

function getServiceWorkerEventBaseKey(eventKey) {
  return String(eventKey || '').replace(/\/s\d+$/, '');
}

function selectCanonicalFilteredEventValue(entries, preferredKey) {
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

function writeJsonFileAtomically(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const fileMode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o600;
  fs.writeFileSync(tempPath, JSON.stringify(payload));
  fs.chmodSync(tempPath, fileMode);
  fs.renameSync(tempPath, filePath);
}

function buildBackupTimestamp() {
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

function backupFileBeforeRepair(filePath) {
  const backupPath = `${filePath}.bak.tm-webrequest-repair.${buildBackupTimestamp()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function compactFilteredWebRequestEvents(extensionSetting, threshold) {
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

  const groupedEntries = new Map();
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

  const nextFilteredEvents = {};
  for (const [eventKey, value] of Object.entries(filteredEvents)) {
    if (!eventKey.startsWith('webRequest.')) {
      nextFilteredEvents[eventKey] = value;
    }
  }

  const canonicalKeys = Array.isArray(extensionSetting.serviceworkerevents)
    ? extensionSetting.serviceworkerevents.filter((eventKey) => eventKey.startsWith('webRequest.'))
    : TAMPERMONKEY_CANONICAL_WEBREQUEST_EVENTS;
  const usedBaseKeys = new Set();

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

function clearSecurePreferenceProtectionForExtension(securePreferences, extensionId) {
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

function repairTampermonkeyWebRequestExplosion(config, profile) {
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

  const repairSummaries = [];
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

function terminateChromeChild(child, reason) {
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

function getChromeProfile(config) {
  if (config.chromeProfileDirectory) {
    return {
      profileDirectory: config.chromeProfileDirectory,
      displayName: config.chromeProfileName || config.chromeProfileDirectory,
    };
  }

  return resolveChromeProfile(config.chromeUserDataDir, config.chromeProfileName);
}

function buildChromeStartupUrls(config) {
  const urls = [
    config.goofishUrl,
    config.qianniuUrl,
  ]
    .map((url) => String(url || '').trim())
    .filter(Boolean);

  return [...new Set(urls)];
}

function hasPreviousSessionData(chromeUserDataDir, profileDirectory) {
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

async function launchChromeAttempt(config) {
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
    '--allow-insecure-localhost',
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

async function ensureChromeDebugging(config) {
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

function startChromeWatchdog(config) {
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

// ── CDP WSS 地址注入 ─────────────────────────────────────────────

/**
 * 通过 CDP 在指定 tab 中执行 JS 表达式。
 * @param {string} wsDebuggerUrl - tab 的 WebSocket 调试地址。
 * @param {string} expression - 要执行的 JS 表达式。
 * @returns {Promise<void>}
 */
function cdpEval(wsDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsDebuggerUrl);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { ws.close(); } catch (_) { }
        reject(new Error('CDP eval timeout'));
      }
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false },
      }));
    });

    ws.on('message', (data) => {
      if (done) return;
      const msg = JSON.parse(data.toString());
      if (msg.id === 1) {
        done = true;
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });

    ws.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * 通过 CDP 向匹配 URL 片段的 tab 注入 JS 表达式。
 * @param {number} cdpPort - CDP 端口。
 * @param {string} urlFragment - 要匹配的 URL 片段。
 * @param {string} expression - 要执行的 JS 表达式。
 */
async function injectToTab(cdpPort, urlFragment, expression) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    if (!res.ok) return;
    const tabs = await res.json();
    const tab = tabs.find(t => t.url && t.url.includes(urlFragment) && t.type === 'page');
    if (!tab) return;
    const wsUrl = tab.webSocketDebuggerUrl || `ws://127.0.0.1:${cdpPort}/devtools/page/${tab.id}`;
    await cdpEval(wsUrl, expression);
  } catch (_) {
    // 注入失败不影响启动，Tampermonkey 脚本的自动重连会在下次读取到正确地址
  }
}

/**
 * 如果设置了 SERVER_HOST，通过 CDP 向目标页面注入远程 WSS 地址到 localStorage。
 * @param {{cdpPort: number, serverHost: string, browserWssPort: number}} config
 */
async function injectWssConfig(config) {
  if (!config.serverHost) return;

  const wssUrl = `wss://${config.serverHost}:${config.browserWssPort}/ws/browser`;
  log(`注入远程 WSS 地址: ${wssUrl}`);

  await injectToTab(config.cdpPort, 'goofish.com/im',
    `localStorage.setItem('xm_server_wss_url', ${JSON.stringify(wssUrl)})`);
  await injectToTab(config.cdpPort, 'myseller.taobao.com',
    `localStorage.setItem('xm_server_wss_url', ${JSON.stringify(wssUrl)})`);
}

// ── 退出处理 ──────────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，准备停止所有子进程`);

  if (chromeWatchTimer) {
    clearInterval(chromeWatchTimer);
    chromeWatchTimer = null;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromeProxyConfigPath =
    process.env.CHROME_PROXY_CONFIG_PATH || DEFAULT_CHROME_PROXY_CONFIG_PATH;
  const localChromeProxyConfig = readLocalJsonConfig(chromeProxyConfigPath);
  const chromeProxyDisabled = process.env.CHROME_PROXY_DISABLED === '1';
  const chromeClearTransientDataEnv = process.env.CHROME_CLEAR_TRANSIENT_DATA_ON_START;
  const rawTampermonkeyThreshold = Number(process.env.CHROME_TAMPERMONKEY_WEBREQUEST_EVENT_THRESHOLD);
  const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:3210';

  const config = {
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
    serverHost: process.env.SERVER_HOST || '',
    browserWssPort: Number(process.env.BROWSER_WSS_PORT || DEFAULT_BROWSER_WSS_PORT),
  };

  setupLogStreams(config);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (config.chromeProxyDisabled) {
    log('已通过 CHROME_PROXY_DISABLED=1 禁用项目 Chrome 代理');
  }

  await ensureChromeDebugging(config);
  await injectWssConfig(config);
  startChromeWatchdog(config);

  log(`启动 sync.js，连接 CDP ${config.cdpPort}，同步到 ${serverUrl}`);
  spawnChild(process.execPath, ['sync.js'], {
    env: {
      ...process.env,
      SERVER_URL: serverUrl,
      CDP_PORT: String(config.cdpPort),
      SYNC_INTERVAL: String(config.syncInterval),
    },
    logTargets: [runtimeLogStream],
  });
}

main().catch((err) => {
  console.error(`[client] 启动失败: ${err.message}`);
  process.exit(1);
});
