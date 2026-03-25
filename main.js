// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const { spawn } = require('child_process');
const path = require('path');
const ROOT_DIR = __dirname;
const SERVER_DIR = path.join(ROOT_DIR, 'server');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const EXTENSION_DIR = path.join(ROOT_DIR, 'chrome_extension');
/**
 * 返回工作区内本地安装的命令行二进制路径。
 * @param {string} workspaceDir - 子项目目录。
 * @param {string} binaryName - 二进制名，例如 vite、tsc。
 * @returns {string} 可执行文件绝对路径。
 */
function getWorkspaceBinaryPath(workspaceDir, binaryName) {
    const extension = process.platform === 'win32' ? '.cmd' : '';
    return path.join(workspaceDir, 'node_modules', '.bin', `${binaryName}${extension}`);
}
/**
 * 兼容不同平台返回可执行命令名。
 * Windows 下 npm 需要走 npm.cmd，其他平台直接使用原命令。
 * @param {string} command - 原始命令名。
 * @returns {string} 适配当前平台后的命令名。
 */
function resolveCommand(command) {
    if (process.platform === 'win32' && command === 'npm') {
        return 'npm.cmd';
    }
    return command;
}
/**
 * 启动一个子进程并等待其退出，默认继承当前终端输出。
 * @param {string} command - 要执行的命令。
 * @param {string[]} args - 命令参数。
 * @param {string} cwd - 子进程工作目录。
 * @param {NodeJS.ProcessEnv} env - 额外环境变量。
 * @returns {Promise<void>} 子进程成功退出时返回。
 */
function runCommand(command, args, cwd = ROOT_DIR, env = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveCommand(command), args, {
            cwd,
            stdio: 'inherit',
            env,
        });
        child.on('error', (error) => {
            reject(error);
        });
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${command} ${args.join(' ')} terminated by signal ${signal}`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
                return;
            }
            resolve();
        });
    });
}
/**
 * 构建 Chrome 扩展与前端产物。
 * 这里直接调用子项目命令，避免依赖根目录 package.json。
 * @returns {Promise<void>} 构建完成后返回。
 */
async function buildWorkspaceArtifacts() {
    console.log('[main] building chrome extension...');
    const extensionVite = getWorkspaceBinaryPath(EXTENSION_DIR, 'vite');
    await runCommand(extensionVite, ['build'], EXTENSION_DIR, {
        ...process.env,
        ENTRY: 'content_script',
    });
    await runCommand(extensionVite, ['build'], EXTENSION_DIR, {
        ...process.env,
        ENTRY: 'background',
    });
    await runCommand(extensionVite, ['build'], EXTENSION_DIR, {
        ...process.env,
        ENTRY: 'popup',
    });
    console.log('[main] building frontend...');
    const frontendTsc = getWorkspaceBinaryPath(FRONTEND_DIR, 'tsc');
    const frontendVite = getWorkspaceBinaryPath(FRONTEND_DIR, 'vite');
    await runCommand(frontendTsc, ['-b'], FRONTEND_DIR);
    await runCommand(frontendVite, ['build'], FRONTEND_DIR);
}
/**
 * 启动服务端统一启动器。
 * 直接运行 server/start.js，避免依赖根目录 npm 脚本。
 * @returns {Promise<void>} 服务退出后返回。
 */
async function startServerStack() {
    await runCommand(process.execPath, ['start.js'], SERVER_DIR);
}
/**
 * 顺序执行构建与启动步骤，作为仓库统一入口。
 * 支持传入 `--start-only` 跳过构建，直接启动服务。
 * 支持传入 `--build-only` 只构建不启动。
 * @returns {Promise<void>} 全部步骤完成后返回。
 */
async function main() {
    const args = process.argv.slice(2);
    const skipBuild = args.includes('--start-only');
    const buildOnly = args.includes('--build-only');
    console.log(`[main] workspace: ${path.basename(ROOT_DIR)}`);
    if (!skipBuild) {
        await buildWorkspaceArtifacts();
    }
    else {
        console.log('[main] skip build, starting server only...');
    }
    if (buildOnly) {
        console.log('[main] build finished, skip start by --build-only');
        return;
    }
    console.log('[main] starting server stack...');
    await startServerStack();
}
main().catch((error) => {
    console.error('[main] failed:', error.message || error);
    process.exit(1);
});
