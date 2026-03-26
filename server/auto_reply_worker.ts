// @ts-nocheck
'use strict';

const path = require('path');
const { loadOptionalEnvFiles } = require('../load_env.ts');

loadOptionalEnvFiles([
    path.join(__dirname, '.env'),
]);

/**
 * auto_reply_worker.ts — 自动回复 Worker (Real-time Version)
 *
 * 消费 outbox 中未处理的 new_messages 事件 → 调用 DeepSeek 生成回复 → 写入 outgoing_messages(pending)
 * Now account-aware: reads auto_reply_enabled per account, targets correct client.
 */

const db = require('./db.ts');
const { generateReply } = require('./ai.ts');

let running = false;
let timeoutId = null;

function log(tag, msg) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${ts}] [${tag}] ${msg}`);
}

function parseRuntimeOptions(argv = process.argv.slice(2)) {
    return {
        dryRun: process.env.AUTO_REPLY_DRY_RUN === '1' || argv.includes('--dry-run'),
        once: argv.includes('--once'),
    };
}

// ── Main process ────────────────────────────────────────────────────────────

async function processOutbox({ dryRun = false } = {}) {
    // Fetch up to 5 unprocessed new_messages events per round
    const events = await db.getUnprocessedOutbox('new_messages', 5);

    if (events.length === 0) {
        return 0;
    }

    let processed = 0;

    for (const event of events) {
        if (!running) break;

        const { id, account_id, chat_key, payload } = event;
        const payloadData = JSON.parse(payload || '{}');
        const newMessages = payloadData.newMessages || [];

        // ── Runtime gate: AI auto-reply enabled (per account) ──
        const autoReplyEnabled = await db.isAutoReplyEnabled(account_id);
        if (!autoReplyEnabled) {
            log('skip', `${chat_key}@${account_id}: AI 自动回复已关闭，当前消息交由人工处理`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        log('process', `Event #${id} → ${chat_key}@${account_id}: ${newMessages.length} new msg(s)`);

        // ── Anti-duplicate check 1: last message direction ──
        const lastDir = await db.getLastMessageDirection(account_id, chat_key);
        if (lastDir === 1) {
            log('skip', `${chat_key}: 最后一条是卖家发的，跳过`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        // ── Anti-duplicate check 2: already has pending outgoing ──
        const hasPending = await db.hasPendingOutgoing(account_id, chat_key);
        if (hasPending) {
            log('skip', `${chat_key}: 已有 pending 消息，跳过`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        // ── Build chat history for LLM ──
        const allMessages = await db.getMessages(account_id, chat_key);
        const chatHistory = allMessages.map(m => ({
            role: m.is_me ? 'seller' : 'buyer',
            content: m.content,
            type: m.type || 'text',
        }));

        // ── Get product info ──
        const session = await db.getSession(account_id, chat_key);
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
            // target_client_id inherited from session.last_seen_client_id
            const customerName = session?.customer_name || chat_key.split('_')[0];
            const productId = session?.product_id || null;
            const result = await db.addOutgoingMessage(
                account_id,
                chat_key,
                reply,
                customerName,
                productId,
                'ai'
            );
            log('queued', `${chat_key}: 入队 #${result.id} → pending (target: ${session?.last_seen_client_id || 'any'})`);

            await db.markOutboxProcessed(id);
            processed++;

            // Small delay between LLM calls to prevent rate limits
            await sleep(1000);
        } catch (err) {
            log('error', `${chat_key}: LLM 调用失败 — ${err.message}`);
            throw err;
        }
    }

    return processed;
}

// ── Exported Controller ─────────────────────────────────────────────────────

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
            timeoutId = setTimeout(loop, 10000);
        }
    };

    loop();
}

function stop() {
    if (!running) return;
    log('worker', 'Stopping Auto-Reply Worker...');
    running = false;
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runCli() {
    const runtimeOptions = parseRuntimeOptions();
    await startAutoReplyWorker({
        intervalMs: 3000,
        dryRun: runtimeOptions.dryRun,
        once: runtimeOptions.once,
    });
}

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
