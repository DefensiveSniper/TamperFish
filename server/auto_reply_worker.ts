// @ts-nocheck
'use strict';

/**
 * auto_reply_worker.js — 自动回复 Worker (Real-time Version)
 *
 * 消费 outbox 中未处理的 new_messages 事件 → 调用 DeepSeek 生成回复 → 写入 outgoing_messages(pending)
 */

const db = require('./db');
const { generateReply } = require('./ai');

let running = false;
let timeoutId = null;

/**
 * 输出统一格式的 worker 日志。
 * @param {string} tag - 日志分类标签。
 * @param {string} msg - 日志内容。
 */
function log(tag, msg) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${ts}] [${tag}] ${msg}`);
}

/**
 * 解析 worker 的运行时选项，兼容 CLI 参数与环境变量。
 * @param {string[]} argv - CLI 参数列表。
 * @returns {{dryRun: boolean, once: boolean}} 归一化后的运行选项。
 */
function parseRuntimeOptions(argv = process.argv.slice(2)) {
    return {
        dryRun: process.env.AUTO_REPLY_DRY_RUN === '1' || argv.includes('--dry-run'),
        once: argv.includes('--once'),
    };
}

// ── Main process ────────────────────────────────────────────────────────────

/**
 * 处理一批 outbox 事件，并按运行模式决定是否真实调用 LLM。
 * @param {{dryRun?: boolean}} options - 处理模式配置。
 * @returns {Promise<number>} 本轮实际处理的事件数量。
 */
async function processOutbox({ dryRun = false } = {}) {
    // 1. Fetch up to 5 unprocessed new_messages events per round
    const events = await db.getUnprocessedOutbox('new_messages', 5);

    if (events.length === 0) {
        return 0; // nothing to do
    }

    let processed = 0;

    for (const event of events) {
        if (!running) break;

        const { id, chat_key, payload } = event;
        const payloadData = JSON.parse(payload || '{}');
        const newMessages = payloadData.newMessages || [];

        // ── Runtime gate: AI auto-reply enabled ──
        const autoReplyEnabled = await db.isAutoReplyEnabled();
        if (!autoReplyEnabled) {
            log('skip', `${chat_key}: AI 自动回复已关闭，当前消息交由人工处理`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        log('process', `Event #${id} → ${chat_key}: ${newMessages.length} new msg(s)`);

        // ── Anti-duplicate check 1: last message direction ──
        const lastDir = await db.getLastMessageDirection(chat_key);
        if (lastDir === 1) {
            log('skip', `${chat_key}: 最后一条是卖家发的，跳过`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        // ── Anti-duplicate check 2: already has pending outgoing ──
        const hasPending = await db.hasPendingOutgoing(chat_key);
        if (hasPending) {
            log('skip', `${chat_key}: 已有 pending 消息，跳过`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        // ── Build chat history for LLM ──
        const allMessages = await db.getMessages(chat_key);
        const chatHistory = allMessages.map(m => ({
            role: m.is_me ? 'seller' : 'buyer',
            content: m.content,
            type: m.type || 'text',
        }));

        // ── Get product info ──
        const session = await db.getSession(chat_key);
        let productInfo = {};
        if (session?.product_json) {
            try { productInfo = JSON.parse(session.product_json); } catch (_) { }
        }

        // ── Generate reply ──
        if (dryRun) {
            log('dry-run', `${chat_key}: would call LLM with ${chatHistory.length} msgs`);
            log('dry-run', `Last buyer msg: "${chatHistory[chatHistory.length - 1]?.content || ''}"`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        try {
            log('llm', `${chat_key}: 调用 DeepSeek 生成回复...`);
            const reply = await generateReply(chatHistory, productInfo);

            if (!reply) {
                log('llm', `${chat_key}: LLM 返回空，不入队`);
                await db.markOutboxProcessed(id);
                processed++;
                continue;
            }

            log('reply', `${chat_key}: "${reply}"`);

            // ── Write to outgoing_messages ──
            // 传入 customer_name + product_id 用于精确路由
            const customerName = session?.customer_name || chat_key.split('_')[0];
            const productId = session?.product_id || null;
            const result = await db.addOutgoingMessage(chat_key, reply, customerName, productId, 'ai');
            log('queued', `${chat_key}: 入队 #${result.id} → pending`);

            await db.markOutboxProcessed(id);
            processed++;

            // Small delay between LLM calls to prevent rate limits
            await sleep(1000);
        } catch (err) {
            log('error', `${chat_key}: LLM 调用失败 — ${err.message}`);
            // Don't mark as processed, let it throw so backoff triggers
            throw err;
        }
    }

    return processed;
}

// ── Exported Controller ─────────────────────────────────────────────────────

/**
 * 启动自动回复 worker，支持长驻模式与单轮执行模式。
 * @param {{intervalMs?: number, dryRun?: boolean, once?: boolean}} options - Worker 启动配置。
 * @returns {Promise<number|undefined>} 单轮模式下返回本次处理数量，长驻模式下无返回值。
 */
async function startAutoReplyWorker({ intervalMs = 3000, dryRun = false, once = false } = {}) {
    if (running) return;
    running = true;

    log('worker', 'Starting Real-Time Auto-Reply Worker...');
    log('worker', `  INTERVAL: ${intervalMs}ms`);
    log('worker', `  DRY_RUN:  ${dryRun}`);
    log('worker', `  ONCE:     ${once}`);

    if (once) {
        try {
            return await processOutbox({ dryRun });
        } finally {
            stop();
        }
    }

    const loop = async () => {
        if (!running) return;
        try {
            await processOutbox({ dryRun });
            timeoutId = setTimeout(loop, intervalMs);
        } catch (err) {
            log('error', `Worker error: ${err.message}. Backing off for 10s...`);
            timeoutId = setTimeout(loop, 10000); // Backoff 10s
        }
    };

    // Start loop
    loop();
}

/**
 * 停止当前运行中的 worker 循环。
 */
function stop() {
    if (!running) return;
    log('worker', 'Stopping Auto-Reply Worker...');
    running = false;
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}

/**
 * 提供简单延时，控制相邻 LLM 请求的最小间隔。
 * @param {number} ms - 延迟毫秒数。
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * 作为 CLI 启动入口，负责组装运行参数并返回适当退出码。
 * @returns {Promise<void>}
 */
async function runCli() {
    const runtimeOptions = parseRuntimeOptions();
    await startAutoReplyWorker({
        intervalMs: 3000,
        dryRun: runtimeOptions.dryRun,
        once: runtimeOptions.once,
    });
}

// Support CLI run for testing (node server/auto_reply_worker.js --dry-run)
if (require.main === module) {
    runCli().catch((err) => {
        log('error', `CLI failed: ${err.message}`);
        process.exit(1);
    });
    process.on('SIGINT', () => { stop(); process.exit(); });
    process.on('SIGTERM', () => { stop(); process.exit(); });
}

module.exports = {
    startAutoReplyWorker,
    stop
};
