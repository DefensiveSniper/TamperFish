'use strict';

/**
 * auto_reply_worker.js — 自动回复 Worker (Kafka Version)
 *
 * 消费 Kafka outbox-events topic → 调用 DeepSeek 生成回复 → 写入 outgoing_messages(pending)
 *
 * 特性:
 *   - 每条消息独立处理，单条失败不阻塞其他消息
 *   - 重试上限 3 次，超限进入 DLQ (outbox-events-dlq)
 *   - 支持并发消费（partitionsConsumedConcurrently）
 */

const db = require('./db');
const { generateReply } = require('./ai');
const { createConsumer, publishEvent, TOPICS } = require('./kafka');

const MAX_RETRIES = 3;
const CONSUMER_GROUP = 'auto-reply-worker';

let consumer = null;
let running = false;

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
 * 提供简单延时，控制相邻 LLM 请求的最小间隔。
 * @param {number} ms - 延迟毫秒数。
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
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

/**
 * 处理单条 Kafka 消息（一个 outbox 事件）。
 * @param {object} params
 * @param {string} params.chatKey - 会话 key。
 * @param {object} params.payloadData - 事件载荷。
 * @param {boolean} params.dryRun - 是否 dry-run 模式。
 */
async function processEvent({ chatKey, payloadData, dryRun }) {
    const newMessages = payloadData.newMessages || [];

    // ── Runtime gate: AI auto-reply enabled ──
    const autoReplyEnabled = await db.isAutoReplyEnabled();
    if (!autoReplyEnabled) {
        log('skip', `${chatKey}: AI 自动回复已关闭，当前消息交由人工处理`);
        return;
    }

    log('process', `${chatKey}: ${newMessages.length} new msg(s)`);

    // ── Anti-duplicate check 1: last message direction ──
    const lastDir = await db.getLastMessageDirection(chatKey);
    if (lastDir === 1) {
        log('skip', `${chatKey}: 最后一条是卖家发的，跳过`);
        return;
    }

    // ── Anti-duplicate check 2: already has pending outgoing ──
    const hasPending = await db.hasPendingOutgoing(chatKey);
    if (hasPending) {
        log('skip', `${chatKey}: 已有 pending 消息，跳过`);
        return;
    }

    // ── Build chat history for LLM ──
    const allMessages = await db.getMessages(chatKey);
    const chatHistory = allMessages.map(m => ({
        role: m.is_me ? 'seller' : 'buyer',
        content: m.content,
        type: m.type || 'text',
    }));

    // ── Get product info ──
    const session = await db.getSession(chatKey);
    let productInfo = {};
    if (session?.product_json) {
        try { productInfo = JSON.parse(session.product_json); } catch (_) { }
    }

    // ── Generate reply ──
    if (dryRun) {
        log('dry-run', `${chatKey}: would call LLM with ${chatHistory.length} msgs`);
        log('dry-run', `Last buyer msg: "${chatHistory[chatHistory.length - 1]?.content || ''}"`);
        return;
    }

    log('llm', `${chatKey}: 调用 DeepSeek 生成回复...`);
    const reply = await generateReply(chatHistory, productInfo);

    if (!reply) {
        log('llm', `${chatKey}: LLM 返回空，不入队`);
        return;
    }

    log('reply', `${chatKey}: "${reply}"`);

    // ── Write to outgoing_messages ──
    const customerName = session?.customer_name || chatKey.split('_')[0];
    const productId = session?.product_id || null;
    const result = await db.addOutgoingMessage(chatKey, reply, customerName, productId, 'ai');
    log('queued', `${chatKey}: 入队 #${result.id} → pending`);

    // Small delay between LLM calls to prevent rate limits
    await sleep(1000);
}

// ── Kafka Consumer ──────────────────────────────────────────────────────────

/**
 * 启动自动回复 worker（Kafka 消费者模式）。
 * @param {{dryRun?: boolean, once?: boolean}} options
 */
async function startAutoReplyWorker({ dryRun = false, once = false } = {}) {
    if (running) return;
    running = true;

    log('worker', 'Starting Kafka Auto-Reply Worker...');
    log('worker', `  DRY_RUN:  ${dryRun}`);
    log('worker', `  ONCE:     ${once}`);

    consumer = createConsumer(CONSUMER_GROUP);
    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Kafka consumer connect timeout (10s)')), 10000));
        await Promise.race([consumer.connect(), timeout]);
        log('worker', 'Consumer connected');
    } catch (err) {
        log('error', `Kafka consumer 连接失败: ${err.message}. Worker 未启动。`);
        running = false;
        consumer = null;
        return;
    }

    await consumer.subscribe({ topic: TOPICS.OUTBOX, fromBeginning: false });

    await consumer.run({
        partitionsConsumedConcurrently: 3,
        eachMessage: async ({ message, heartbeat }) => {
            if (!running) return;

            const chatKey = message.key?.toString() || 'unknown';
            const retryCount = parseInt(message.headers?.retryCount?.toString() || '0', 10);

            let payloadData;
            try {
                payloadData = JSON.parse(message.value.toString());
            } catch (parseErr) {
                log('error', `${chatKey}: 无法解析消息载荷: ${parseErr.message}`);
                return; // 不可恢复，直接跳过（消息已 commit）
            }

            try {
                await processEvent({ chatKey, payloadData, dryRun });

                // 同步标记 SQLite outbox（best-effort）
                try {
                    const outboxEvents = await db.getUnprocessedOutbox('new_messages', 100);
                    const match = outboxEvents.find(e => {
                        try {
                            const p = JSON.parse(e.payload || '{}');
                            return p.chatKey === chatKey;
                        } catch { return false; }
                    });
                    if (match) await db.markOutboxProcessed(match.id);
                } catch (_) { /* best-effort */ }

                await heartbeat();
            } catch (err) {
                log('error', `${chatKey}: 处理失败 (retry ${retryCount}/${MAX_RETRIES}) — ${err.message}`);

                if (retryCount >= MAX_RETRIES) {
                    // 超过重试上限 → 发送到 DLQ
                    log('dlq', `${chatKey}: 超过 ${MAX_RETRIES} 次重试，移入 DLQ`);
                    try {
                        await publishEvent(TOPICS.DLQ, chatKey, {
                            ...payloadData,
                            error: err.message,
                            failedAt: new Date().toISOString(),
                            retryCount,
                        });
                    } catch (dlqErr) {
                        log('error', `${chatKey}: DLQ 发布失败: ${dlqErr.message}`);
                    }
                } else {
                    // 重新发布到主 topic，递增 retryCount
                    try {
                        await publishEvent(TOPICS.OUTBOX, chatKey, payloadData, {
                            retryCount: String(retryCount + 1),
                        });
                        log('retry', `${chatKey}: 重新入队 (retry ${retryCount + 1})`);
                    } catch (repubErr) {
                        log('error', `${chatKey}: 重新入队失败: ${repubErr.message}`);
                    }
                }
                // 消息已处理（成功或进入重试/DLQ），不抛出异常，不阻塞其他消息
            }
        },
    });

    if (once) {
        // 单次模式：等待短暂时间消费积压消息后退出
        await sleep(5000);
        await stop();
    }
}

/**
 * 停止当前运行中的 Kafka consumer。
 */
async function stop() {
    if (!running) return;
    log('worker', 'Stopping Kafka Auto-Reply Worker...');
    running = false;
    if (consumer) {
        try {
            await consumer.disconnect();
        } catch (_) { /* ignore */ }
        consumer = null;
    }
}

// ── CLI Entry ───────────────────────────────────────────────────────────────

async function runCli() {
    const runtimeOptions = parseRuntimeOptions();
    await startAutoReplyWorker({
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
