'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SERVER_PORT = 3210;
const DEFAULT_API_LOG_PATH = path.join(__dirname, 'server3210.log');

const children = [];
let shuttingDown = false;
let apiLogStream = null;

/**
 * 解析命令行参数。
 * @param {string[]} argv - 进程参数列表。
 * @returns {{watch: boolean}} 解析后的启动选项。
 */
function parseArgs(argv) {
  return {
    watch: argv.includes('--watch'),
  };
}

/**
 * 向日志流安全写入内容；流已结束或销毁时静默跳过。
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
    // 退出阶段允许日志丢失
  }
}

/**
 * 统一输出启动日志。
 * @param {string} message - 要输出的日志内容。
 */
function log(message) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [server] ${message}\n`;
  process.stdout.write(line);
  writeToStreamSafely(apiLogStream, line);
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
 * 处理退出信号，避免子进程残留。
 * @param {NodeJS.Signals} signal - 当前收到的系统信号。
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，准备停止所有子进程`);

  for (const child of children) {
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch (_) {
        // 忽略清理阶段的个别失败
      }
    }
  }

  if (apiLogStream) {
    apiLogStream.end();
  }

  setTimeout(() => process.exit(0), 500);
}

/**
 * 组装配置并启动 API 服务。
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = {
    watch: args.watch,
    serverPort: Number(process.env.PORT || DEFAULT_SERVER_PORT),
    apiLogPath: process.env.API_LOG_PATH || DEFAULT_API_LOG_PATH,
  };

  apiLogStream = fs.createWriteStream(config.apiLogPath, { flags: 'a' });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const nodeArgs = config.watch ? ['--watch', 'index.js'] : ['index.js'];
  log(`启动 API 服务，端口 ${config.serverPort}`);
  spawnChild(process.execPath, nodeArgs, {
    env: {
      ...process.env,
      PORT: String(config.serverPort),
    },
    logTargets: [apiLogStream],
  });
}

main().catch((err) => {
  console.error(`[server] 启动失败: ${err.message}`);
  process.exit(1);
});
