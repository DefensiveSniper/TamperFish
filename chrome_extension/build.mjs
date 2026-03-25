import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vitePackagePath = require.resolve('vite/package.json');
const viteBin = join(dirname(vitePackagePath), 'bin', 'vite.js');
const ALL_ENTRIES = ['content_script', 'background', 'popup'];

/**
 * 解析构建脚本命令行参数，支持指定单入口和 watch 模式。
 * @param {string[]} argv - 传入脚本的原始参数列表。
 * @returns {{ watch: boolean, entries: string[] }} 归一化后的构建配置。
 */
function parseArgs(argv) {
  const watch = argv.includes('--watch');
  const entryIndex = argv.indexOf('--entry');
  const specifiedEntry = entryIndex >= 0 ? argv[entryIndex + 1] : '';

  if (specifiedEntry && !ALL_ENTRIES.includes(specifiedEntry)) {
    throw new Error(`Unsupported entry: ${specifiedEntry}`);
  }

  return {
    watch,
    entries: specifiedEntry ? [specifiedEntry] : ALL_ENTRIES,
  };
}

/**
 * 启动一轮 vite 构建，并把指定入口名通过环境变量传给 vite 配置。
 * @param {{ entry: string, watch: boolean }} options - 当前入口的构建参数。
 * @returns {Promise<void>} 构建完成后结束；失败时抛错。
 */
function runViteBuild({ entry, watch }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [viteBin, 'build', ...(watch ? ['--watch'] : [])],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          ENTRY: entry,
        },
      }
    );

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `vite build failed for entry "${entry}" with code=${code ?? 'null'} signal=${signal ?? 'none'}`
        )
      );
    });
  });
}

/**
 * 串行执行所有入口构建，保证 `dist/` 的清空与追加顺序稳定。
 * @returns {Promise<void>} 全部入口构建完成后结束。
 */
async function main() {
  const config = parseArgs(process.argv.slice(2));

  for (const entry of config.entries) {
    await runViteBuild({ entry, watch: config.watch });
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
