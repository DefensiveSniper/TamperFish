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
const DEFAULT_CHROME_MONITOR_INTERVAL_MS = 3000;
const DEFAULT_CHROME_USER_DATA_DIR = path.join(__dirname, '..', '.chrome-xianyu-profile');
const DEFAULT_CHROME_PROFILE_DIRECTORY = 'Default';
const DEFAULT_RUNTIME_LOG_PATH = path.join(__dirname, 'server.log');
const DEFAULT_API_LOG_PATH = path.join(__dirname, 'server3210.log');
const DEFAULT_CHROME_PROXY_CONFIG_PATH = path.join(__dirname, '.chrome-proxy.local.json');
const DEFAULT_CHROME_PROXY_SCHEME = 'http';
const DEFAULT_CHROME_PROXY_BYPASS_LIST = 'localhost;127.0.0.1;::1';
const DEFAULT_CHROME_PROXY_EXTENSION_DIR = path.join(__dirname, '.chrome-proxy-extension');

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
 * 统一输出启动日志，便于区分 bootstrap 与业务进程。
 * @param {string} message - 要输出的日志内容。
 */
function log(message) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [bootstrap] ${message}\n`;
  process.stdout.write(line);
  if (runtimeLogStream) {
    runtimeLogStream.write(line);
  }
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
        stream.write(chunk);
      }
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      for (const stream of targets) {
        stream.write(chunk);
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
  return !!details.isProxy
    && details.challenger
    && details.challenger.host === proxyConfig.host
    && Number(details.challenger.port) === Number(proxyConfig.port);
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
 * @returns {{args: string[], logMessage: string | null}} 代理参数与脱敏日志。
 */
function buildChromeProxyArgs(config) {
  if (!hasChromeProxy(config)) {
    return { args: [], logMessage: null };
  }

  const normalizedProxy = normalizeChromeProxyServer(
    config.chromeProxyServer,
    config.chromeProxyScheme
  );
  if (!normalizedProxy) {
    return { args: [], logMessage: null };
  }

  const args = [`--proxy-server=${normalizedProxy.serverArg}`];
  if (config.chromeProxyBypassList) {
    args.push(`--proxy-bypass-list=${config.chromeProxyBypassList}`);
  }

  const proxyExtensionDir = ensureChromeProxyExtension(config);
  if (proxyExtensionDir) {
    args.push(`--load-extension=${proxyExtensionDir}`);
  }

  return {
    args,
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
 * 拉起带 CDP 调试端口的 Chrome，并尝试打开 goofish IM 页面。
 * @param {{cdpPort: number, goofishUrl: string, chromeUserDataDir: string, chromeProfileName: string, chromeProfileDirectory: string}} config - Chrome 启动配置。
 * @returns {Promise<void>}
 */
async function ensureChromeDebugging(config) {
  const alreadyListening = await isPortOpen(config.cdpPort);
  if (alreadyListening) {
    log(`检测到 Chrome 已监听 ${config.cdpPort}，跳过重复拉起`);
    return;
  }

  ensureChromeUserDataDir(config.chromeUserDataDir);
  const profile = getChromeProfile(config);
  const proxyArgs = buildChromeProxyArgs(config);

  const launchBase = getChromeLaunchBase();
  const launchArgs = [
    ...launchBase.baseArgs,
    '--no-first-run',
    ...proxyArgs.args,
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.chromeUserDataDir}`,
    `--profile-directory=${profile.profileDirectory}`,
    config.goofishUrl,
  ];

  log(
    `拉起 Chrome profile "${profile.displayName}" (${profile.profileDirectory})，用户数据目录 ${config.chromeUserDataDir}，监听 ${config.cdpPort}`
  );
  if (proxyArgs.logMessage) {
    log(proxyArgs.logMessage);
  }
  spawnChild(launchBase.command, launchArgs, {
    detached: process.platform !== 'win32',
    logTargets: [runtimeLogStream],
  });

  const ready = await waitForPort(config.cdpPort, 15000);
  if (!ready) {
    throw new Error(`Chrome 未在 15 秒内开放 ${config.cdpPort} 调试端口`);
  }
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
    runtimeLogPath: process.env.RUNTIME_LOG_PATH || DEFAULT_RUNTIME_LOG_PATH,
    apiLogPath: process.env.API_LOG_PATH || DEFAULT_API_LOG_PATH,
    chromeProxyServer:
      process.env.CHROME_PROXY_SERVER || localChromeProxyConfig.proxyServer || '',
    chromeProxyScheme:
      process.env.CHROME_PROXY_SCHEME ||
      localChromeProxyConfig.proxyScheme ||
      DEFAULT_CHROME_PROXY_SCHEME,
    chromeProxyUsername:
      process.env.CHROME_PROXY_USERNAME || localChromeProxyConfig.proxyUsername || '',
    chromeProxyPassword:
      process.env.CHROME_PROXY_PASSWORD || localChromeProxyConfig.proxyPassword || '',
    chromeProxyBypassList:
      process.env.CHROME_PROXY_BYPASS_LIST ||
      localChromeProxyConfig.proxyBypassList ||
      DEFAULT_CHROME_PROXY_BYPASS_LIST,
    chromeProxyExtensionDir: DEFAULT_CHROME_PROXY_EXTENSION_DIR,
  };

  setupLogStreams(config);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await ensureChromeDebugging(config);
  startChromeWatchdog(config);
  startRuntimeProcesses(config);
}

main().catch((err) => {
  console.error(`[bootstrap] 启动失败: ${err.message}`);
  process.exit(1);
});
