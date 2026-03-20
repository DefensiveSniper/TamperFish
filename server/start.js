'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_CDP_PORT = 18800;
const DEFAULT_SERVER_PORT = 3210;
const DEFAULT_SYNC_INTERVAL = 5000;
const DEFAULT_PROFILE_NAME = 'xianyu';
const DEFAULT_GOOFISH_URL = 'https://www.goofish.com/im';
const DEFAULT_QIANNIU_URL = 'https://myseller.taobao.com/home.htm/batch-consign';
const DEFAULT_CHROME_MONITOR_INTERVAL_MS = 3000;
const DEFAULT_CHROME_USER_DATA_DIR = path.join(__dirname, '..', '.chrome-xianyu-profile');
const DEFAULT_CHROME_PROFILE_DIRECTORY = 'Default';
const DEFAULT_RUNTIME_LOG_PATH = path.join(__dirname, 'server.log');
const DEFAULT_API_LOG_PATH = path.join(__dirname, 'server3210.log');
const DEFAULT_CHROME_PROXY_CONFIG_PATH = path.join(__dirname, '.chrome-proxy.local.json');
const DEFAULT_CHROME_PROXY_SCHEME = 'http';
const DEFAULT_CHROME_PROXY_BYPASS_LIST = 'localhost;127.0.0.1;::1';
const DEFAULT_CHROME_PROXY_EXTENSION_DIR = path.join(__dirname, '.chrome-proxy-extension');
const DEFAULT_CHROME_CLEAR_TRANSIENT_DATA_ON_START = true;
const DEFAULT_CHROME_START_TIMEOUT_MS = 15000;
const DEFAULT_CHROME_REPAIR_TAMPERMONKEY_WEBREQUEST_ON_START = true;
const DEFAULT_TAMPERMONKEY_WEBREQUEST_EVENT_THRESHOLD = 4096;
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
let apiLogStream = null;
let chromeWatchTimer = null;
let chromeEnsuring = false;

/**
 * 解析统一启动器的命令行参数。
 * @param {string[]} argv - 进程参数列表。
 * @returns {{watch: boolean}} 解析后的启动选项。
 */
function parseArgs(argv) {
  return {
    watch: argv.includes('--watch'),
  };
}

/**
 * 向日志流安全写入内容；流已结束或销毁时静默跳过，避免退出阶段抛出 write-after-end。
 * @param {NodeJS.WritableStream | null | undefined} stream - 目标日志流。
 * @param {string | Buffer} chunk - 要写入的内容。
 */
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

/**
 * 统一输出启动日志，便于区分 bootstrap 与业务进程。
 * @param {string} message - 要输出的日志内容。
 */
function log(message) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [bootstrap] ${message}\n`;
  process.stdout.write(line);
  writeToStreamSafely(runtimeLogStream, line);
}

/**
 * 初始化运行期日志文件输出流。
 * @param {{runtimeLogPath: string, apiLogPath: string}} config - 日志配置。
 */
function setupLogStreams(config) {
  runtimeLogStream = fs.createWriteStream(config.runtimeLogPath, { flags: 'a' });
  apiLogStream = fs.createWriteStream(config.apiLogPath, { flags: 'a' });
}

/**
 * 读取本地 JSON 配置文件；不存在时返回空对象，避免强制要求用户先手工建文件。
 * @param {string} filePath - JSON 配置文件路径。
 * @returns {Record<string, any>} 解析后的配置对象。
 */
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

/**
 * 将子进程输出同时写入终端和指定日志文件。
 * @param {import('child_process').ChildProcess} child - 子进程对象。
 * @param {NodeJS.WritableStream[]} targets - 目标输出流列表。
 */
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

/**
 * 返回当前系统可执行的 Chrome 启动命令。
 * @returns {{command: string, baseArgs: string[]}} 启动命令与固定参数。
 */
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

/**
 * 将代理地址标准化为 Chrome 可接受的 `scheme://host:port` 格式。
 * @param {string} rawProxyServer - 原始代理地址，可为 `host:port` 或完整 URL。
 * @param {string} defaultScheme - 缺省协议，默认 `http`。
 * @returns {{serverArg: string, host: string, port: number, scheme: string} | null} 标准化结果。
 */
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

/**
 * 判断本次启动是否启用了 Chrome 代理。
 * @param {{chromeProxyServer?: string}} config - 启动配置。
 * @returns {boolean} 是否需要为 Chrome 注入代理参数。
 */
function hasChromeProxy(config) {
  return !!config.chromeProxyServer;
}

/**
 * 生成 Chrome 代理认证扩展，解决带账号密码的代理在命令行下无法直接透传认证的问题。
 * @param {{
 *   chromeProxyServer: string,
 *   chromeProxyScheme: string,
 *   chromeProxyUsername: string,
 *   chromeProxyPassword: string,
 *   chromeProxyExtensionDir: string
 * }} config - 代理配置。
 * @returns {string | null} 生成好的扩展目录；无需认证时返回 null。
 */
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
  // 代理服务可能经过转发、解析为 IP，或返回与配置项不同的 challenger 标识。
  // 只要当前请求明确是代理鉴权，就直接回填项目配置中的账号密码，避免因为 host/port
  // 精确匹配失败而落回浏览器原生弹窗。
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

/**
 * 根据配置组装 Chrome 代理相关启动参数。
 * @param {{
 *   chromeProxyServer: string,
  *   chromeProxyScheme: string,
  *   chromeProxyBypassList: string,
 *   chromeProxyUsername: string,
 *   chromeProxyPassword: string,
 *   chromeProxyExtensionDir: string
 * }} config - 代理配置。
 * @returns {{args: string[], extensionDirs: string[], logMessage: string | null}} 代理参数与脱敏日志。
 */
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

/**
 * 从指定的 Chrome 用户数据目录中解析 profile 展示名对应的真实目录名。
 * @param {string} userDataRoot - Chrome 用户数据根目录。
 * @param {string} profileName - 用户看到的 profile 名称。
 * @returns {{profileDirectory: string, displayName: string}} 匹配到的目录信息。
 */
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

/**
 * 确保 Chrome 用户数据目录存在，便于直接使用项目专用 profile。
 * @param {string} userDataRoot - Chrome 用户数据根目录。
 * @returns {void}
 */
function ensureChromeUserDataDir(userDataRoot) {
  fs.mkdirSync(userDataRoot, { recursive: true });
}

/**
 * 删除单个文件或目录；不存在时静默跳过。
 * @param {string} targetPath - 待删除的路径。
 * @returns {boolean} 本次是否实际删除了目标。
 */
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

/**
 * 清理 Chrome 用户数据目录中的残留单例锁文件，避免上次异常退出后阻塞新实例启动。
 * @param {string} userDataRoot - Chrome 用户数据根目录。
 * @returns {string[]} 本次实际删除的相对路径列表。
 */
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

/**
 * 清理项目专用 Chrome profile 的瞬态缓存，保留登录态、扩展和站点数据不动。
 * 这类缓存膨胀或损坏时，容易造成浏览器启动卡死或网络服务异常重启。
 * @param {{chromeUserDataDir: string, chromeClearTransientDataOnStart: boolean}} config - Chrome 启动配置。
 * @param {{profileDirectory: string}} profile - 当前要使用的 profile 信息。
 */
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

/**
 * 判断扩展配置是否指向 Tampermonkey，兼容中英文名称。
 * @param {Record<string, any>} extensionSetting - 单个扩展的 Secure Preferences 配置。
 * @returns {boolean} 是否命中 Tampermonkey。
 */
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

/**
 * 去掉 service worker 事件键尾部的 `/s123` 形式实例编号，得到稳定基名。
 * @param {string} eventKey - 原始事件键。
 * @returns {string} 事件基名。
 */
function getServiceWorkerEventBaseKey(eventKey) {
  return String(eventKey || '').replace(/\/s\d+$/, '');
}

/**
 * 从一组重复的 webRequest 子事件里选出要保留到规范键上的过滤条件。
 * 优先保留规范键本身，其次保留非空过滤条件，最后退回最短键名。
 * @param {{key: string, value: any}[]} entries - 同一基名下的候选事件项。
 * @param {string} preferredKey - 期望保留的规范键名。
 * @returns {any} 应写回规范键的过滤条件。
 */
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

/**
 * 原子写回 JSON 文件，并尽量保留原文件权限。
 * @param {string} filePath - 目标文件路径。
 * @param {Record<string, any>} payload - 要写入的 JSON 对象。
 */
function writeJsonFileAtomically(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const fileMode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o600;
  fs.writeFileSync(tempPath, JSON.stringify(payload));
  fs.chmodSync(tempPath, fileMode);
  fs.renameSync(tempPath, filePath);
}

/**
 * 生成当前时间对应的紧凑文件名时间戳。
 * @returns {string} 形如 `20260312_184500` 的时间戳。
 */
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

/**
 * 备份即将修复的 Secure Preferences 文件，便于必要时人工回滚。
 * @param {string} filePath - 原始文件路径。
 * @returns {string} 备份文件路径。
 */
function backupFileBeforeRepair(filePath) {
  const backupPath = `${filePath}.bak.tm-webrequest-repair.${buildBackupTimestamp()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * 压缩单个扩展里异常膨胀的 webRequest service worker 子事件，只保留规范键。
 * @param {Record<string, any>} extensionSetting - 单个扩展的 Secure Preferences 配置。
 * @param {number} threshold - 触发修复的最小子事件数量。
 * @returns {{changed: boolean, removedKeys: number, beforeCount: number, afterCount: number}} 修复结果摘要。
 */
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

/**
 * 删除被修复扩展对应的 Secure Preferences 校验项，避免 Chrome 把修复后的 JSON 视为外部篡改。
 * @param {Record<string, any>} securePreferences - 已解析的 Secure Preferences 对象。
 * @param {string} extensionId - 目标扩展 ID。
 */
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

/**
 * 从 Chrome Secure Preferences 中查找 Tampermonkey 扩展 ID，用于脚本自动更新。
 * @param {string} chromeUserDataDir - Chrome 用户数据目录。
 * @param {string} profileDirectory - profile 子目录名。
 * @returns {string | null} Tampermonkey 扩展 ID，未找到时返回 null。
 */
function findTampermonkeyExtensionId(chromeUserDataDir, profileDirectory) {
  const securePreferencesPath = path.join(chromeUserDataDir, profileDirectory, 'Secure Preferences');
  if (!fs.existsSync(securePreferencesPath)) return null;

  let securePreferences;
  try {
    securePreferences = JSON.parse(fs.readFileSync(securePreferencesPath, 'utf8'));
  } catch (_) {
    return null;
  }

  const extensionSettings = securePreferences?.extensions?.settings;
  if (!extensionSettings || typeof extensionSettings !== 'object') return null;

  for (const [extensionId, extensionSetting] of Object.entries(extensionSettings)) {
    if (isTampermonkeyExtensionSetting(extensionSetting)) {
      return extensionId;
    }
  }
  return null;
}

/**
 * 启动前修复 Tampermonkey 在 Secure Preferences 中膨胀的 webRequest 子事件注册。
 * 这类异常会让 Chrome 在恢复扩展 service worker 监听时卡死，表现为窗口直接“未响应”。
 * @param {{
 *   chromeUserDataDir: string,
 *   chromeRepairTampermonkeyWebRequestOnStart: boolean,
 *   tampermonkeyWebRequestEventThreshold: number
 * }} config - 启动配置。
 * @param {{profileDirectory: string}} profile - 当前要启动的 Chrome profile 信息。
 */
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

/**
 * 终止当前拉起但未成功就绪的 Chrome 子进程，避免失败实例残留在后台继续占资源。
 * @param {import('child_process').ChildProcess | null | undefined} child - 待终止的 Chrome 进程句柄。
 * @param {string} reason - 终止原因，用于日志。
 */
function terminateChromeChild(child, reason) {
  if (!child || child.killed) {
    return;
  }

  log(reason);
  try {
    child.kill('SIGTERM');
  } catch (_) {
    // 启动失败清理阶段忽略 kill 异常，后续仍以端口监听结果为准。
  }
}

/**
 * 根据配置解析实际要使用的 Chrome profile。
 * @param {{chromeUserDataDir: string, chromeProfileName: string, chromeProfileDirectory: string}} config - Chrome 配置。
 * @returns {{profileDirectory: string, displayName: string}} 解析后的 profile 信息。
 */
function getChromeProfile(config) {
  if (config.chromeProfileDirectory) {
    return {
      profileDirectory: config.chromeProfileDirectory,
      displayName: config.chromeProfileName || config.chromeProfileDirectory,
    };
  }

  return resolveChromeProfile(config.chromeUserDataDir, config.chromeProfileName);
}
/**
 * 汇总 Chrome 启动时要直接打开的业务页面 URL，并去掉空值与重复项。
 * @param {{goofishUrl?: string, qianniuUrl?: string}} config - 启动配置。
 * @returns {string[]} 去重后的启动 URL 列表。
 */
function buildChromeStartupUrls(config) {
  const urls = [
    config.goofishUrl,
    config.qianniuUrl,
  ]
    .map((url) => String(url || '').trim())
    .filter(Boolean);

  return [...new Set(urls)];
}

/**
 * 判断指定 profile 中是否存在可用的上次会话恢复数据。
 * Chrome 需要 Sessions 目录中的 Session_/Tabs_ 文件来执行 --restore-last-session。
 * @param {string} chromeUserDataDir - Chrome 用户数据根目录。
 * @param {string} profileDirectory - profile 目录名。
 * @returns {boolean} 是否存在上次会话数据。
 */
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

/**
 * 检查本机端口是否已经在监听。
 * @param {number} port - 要检查的端口。
 * @returns {Promise<boolean>} 端口是否可连接。
 */
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

/**
 * 等待本机端口在超时时间内进入监听状态。
 * @param {number} port - 要等待的端口。
 * @param {number} timeoutMs - 最长等待时间。
 * @returns {Promise<boolean>} 是否在超时前成功监听。
 */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * 统一封装子进程启动，便于继承日志和做退出清理。
 * @param {string} command - 可执行命令。
 * @param {string[]} args - 命令参数。
 * @param {import('child_process').SpawnOptions & {logTargets?: NodeJS.WritableStream[]}} options - 子进程启动选项。
 * @returns {import('child_process').ChildProcess} 启动后的子进程对象。
 */
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

/**
 * 按给定 profile 配置拉起一轮 Chrome，并等待 DevTools 端口就绪。
 * @param {{
 *   cdpPort: number,
 *   goofishUrl: string,
 *   qianniuUrl: string,
 *   chromeUserDataDir: string,
 *   chromeProfileName: string,
 *   chromeProfileDirectory: string,
 *   chromeClearTransientDataOnStart: boolean,
 *   chromeStartTimeoutMs: number
 * }} config - Chrome 启动配置。
 * @returns {Promise<{child: import('child_process').ChildProcess, profile: {profileDirectory: string, displayName: string}, ready: boolean}>} 本轮启动结果。
 */
async function launchChromeAttempt(config) {
  ensureChromeUserDataDir(config.chromeUserDataDir);
  const profile = getChromeProfile(config);
  clearChromeTransientData(config, profile);
  repairTampermonkeyWebRequestExplosion(config, profile);
  const proxyArgs = buildChromeProxyArgs(config);

  // 有上次会话时走 --restore-last-session 恢复标签页与 session cookie，不再重复传入 URL；
  // 首次启动（无会话数据）时正常传入启动页 URL。
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

/**
 * 拉起带 CDP 调试端口的 Chrome；若启动超时则终止失败实例并直接报错。
 * @param {{
 *   cdpPort: number,
 *   goofishUrl: string,
 *   qianniuUrl: string,
 *   chromeUserDataDir: string,
 *   chromeProfileName: string,
 *   chromeProfileDirectory: string,
 *   chromeClearTransientDataOnStart: boolean,
 *   chromeStartTimeoutMs: number
 * }} config - Chrome 启动配置。
 * @returns {Promise<void>}
 */
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

/**
 * 启动 Chrome 监听守护，发现调试端口丢失时自动重新拉起项目专用浏览器。
 * @param {{cdpPort: number, chromeMonitorIntervalMs: number, chromeUserDataDir: string}} config - Chrome 守护配置。
 */
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

/**
 * 启动 API 服务与同步进程，并绑定退出清理。
 * @param {{watch: boolean, serverPort: number, cdpPort: number, syncInterval: number}} config - 业务进程配置。
 */
function startRuntimeProcesses(config) {
  const nodeArgs = config.watch ? ['--watch', 'index.js'] : ['index.js'];

  log(`启动 API 服务，端口 ${config.serverPort}`);
  spawnChild(process.execPath, nodeArgs, {
    env: {
      ...process.env,
      PORT: String(config.serverPort),
      CDP_PORT: String(config.cdpPort),
      TAMPERMONKEY_EXTENSION_ID: config.tampermonkeyExtensionId || '',
    },
    logTargets: [runtimeLogStream, apiLogStream],
  });

  log(`启动 sync.js，连接 CDP ${config.cdpPort}`);
  spawnChild(process.execPath, ['sync.js'], {
    env: {
      ...process.env,
      SERVER_URL: `http://127.0.0.1:${config.serverPort}`,
      CDP_PORT: String(config.cdpPort),
      SYNC_INTERVAL: String(config.syncInterval),
    },
    logTargets: [runtimeLogStream],
  });
}

/**
 * 处理退出信号，避免 API 与 sync 子进程残留。
 * @param {NodeJS.Signals} signal - 当前收到的系统信号。
 */
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
        // 忽略清理阶段的个别失败，保证其余子进程继续结束。
      }
    }
  }

  if (runtimeLogStream) {
    runtimeLogStream.end();
  }
  if (apiLogStream) {
    apiLogStream.end();
  }

  setTimeout(() => process.exit(0), 500);
}

/**
 * 提供简单 sleep，便于轮询等待端口。
 * @param {number} ms - 等待毫秒数。
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统一组装启动配置并执行项目引导。
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromeProxyConfigPath =
    process.env.CHROME_PROXY_CONFIG_PATH || DEFAULT_CHROME_PROXY_CONFIG_PATH;
  const localChromeProxyConfig = readLocalJsonConfig(chromeProxyConfigPath);
  const chromeProxyDisabled = process.env.CHROME_PROXY_DISABLED === '1';
  const chromeClearTransientDataEnv = process.env.CHROME_CLEAR_TRANSIENT_DATA_ON_START;
  const rawTampermonkeyThreshold = Number(process.env.CHROME_TAMPERMONKEY_WEBREQUEST_EVENT_THRESHOLD);
  const config = {
    watch: args.watch,
    serverPort: Number(process.env.PORT || DEFAULT_SERVER_PORT),
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
    apiLogPath: process.env.API_LOG_PATH || DEFAULT_API_LOG_PATH,
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
  };

  setupLogStreams(config);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (config.chromeProxyDisabled) {
    log('已通过 CHROME_PROXY_DISABLED=1 禁用项目 Chrome 代理');
  }

  await ensureChromeDebugging(config);

  // 发现 Tampermonkey 扩展 ID，用于脚本自动更新
  const profile = getChromeProfile(config);
  config.tampermonkeyExtensionId = findTampermonkeyExtensionId(
    config.chromeUserDataDir,
    profile.profileDirectory
  ) || '';
  if (config.tampermonkeyExtensionId) {
    log(`发现 Tampermonkey 扩展 ID: ${config.tampermonkeyExtensionId}`);
  } else {
    log('未找到 Tampermonkey 扩展，脚本自动更新不可用');
  }

  startChromeWatchdog(config);
  startRuntimeProcesses(config);
}

main().catch((err) => {
  console.error(`[bootstrap] 启动失败: ${err.message}`);
  process.exit(1);
});
