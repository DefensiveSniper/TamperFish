'use strict';

/**
 * auto_reply_worker.js — 自动回复 Worker (双模式)
 *
 * Kafka 可用时: 消费 Kafka outbox-events topic，支持并发、重试上限、DLQ
 * Kafka 不可用时: 降级回 SQLite outbox 轮询，但修复了 head-of-line blocking
 *
 * 两种模式共享 processEvent() 业务逻辑。
 */

const db = require('./db');
const { generateReply } = require('./ai');
const { isAvailable: isKafkaAvailable, createConsumer, publishEvent, TOPICS } = require('./kafka');

const MAX_RETRIES = 3;
const CONSUMER_GROUP = 'auto-reply-worker';

let consumer = null;
let running = false;
let timeoutId = null;

/**
 * 输出统一格式的 worker 日志。
 */
function log(tag, msg) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${ts}] [${tag}] ${msg}`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function parseRuntimeOptions(argv = process.argv.slice(2)) {
    return {
        dryRun: process.env.AUTO_REPLY_DRY_RUN === '1' || argv.includes('--dry-run'),
        once: argv.includes('--once'),
    };
}

// ── 共享业务逻辑 ────────────────────────────────────────────────────────────

/**
 * 处理单条 outbox 事件。
 */
async function processEvent({ chatKey, payloadData, dryRun }) {
    const newMessages = payloadData.newMessages || [];

    const autoReplyEnabled = await db.isAutoReplyEnabled();
    if (!autoReplyEnabled) {
        log('skip', `${chatKey}: AI 自动回复已关闭，当前消息交由人工处理`);
        return;
    }

    log('process', `${chatKey}: ${newMessages.length} new msg(s)`);

    const lastDir = await db.getLastMessageDirection(chatKey);
    if (lastDir === 1) {
        log('skip', `${chatKey}: 最后一条是卖家发的，跳过`);
        return;
    }

    const hasPending = await db.hasPendingOutgoing(chatKey);
    if (hasPending) {
        log('skip', `${chatKey}: 已有 pending 消息，跳过`);
        return;
    }

    const allMessages = await db.getMessages(chatKey);
    const chatHistory = allMessages.map(m => ({
        role: m.is_me ? 'seller' : 'buyer',
        content: m.content,
        type: m.type || 'text',
    }));

    const session = await db.getSession(chatKey);
    let productInfo = {};
    if (session?.product_json) {
        try { productInfo = JSON.parse(session.product_json); } catch (_) { }
    }

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

    const customerName = session?.customer_name || chatKey.split('_')[0];
    const productId = session?.product_id || null;
    const result = await db.addOutgoingMessage(chatKey, reply, customerName, productId, 'ai');
    log('queued', `${chatKey}: 入队 #${result.id} → pending`);

    await sleep(1000);
}

// ── 模式 A: Kafka Consumer ──────────────────────────────────────────────────

async function startKafkaWorker({ dryRun, once }) {
    log('worker', 'Starting Kafka Auto-Reply Worker...');

    consumer = createConsumer(CONSUMER_GROUP);
    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Kafka consumer connect timeout (10s)')), 10000));
        await Promise.race([consumer.connect(), timeout]);
        log('worker', 'Kafka consumer connected');
    } catch (err) {
        log('error', `Kafka consumer 连接失败: ${err.message}. 降级到 SQLite 轮询模式。`);
        consumer = null;
        return false; // 降级信号
    }

    // 防止 consumer crash 事件杀掉 Node 进程
    consumer.on('consumer.crash', ({ payload: { error, groupId } }) => {
        log('error', `Kafka consumer crash (group=${groupId}): ${error.message}`);
        log('worker', '将在下次重启时重新连接 Kafka，当前不影响 SQLite 轮询。');
    });

    // 确保 topic 存在（auto.create.topics.enable 仅在 producer send 时触发）
    try {
        await publishEvent(TOPICS.OUTBOX, '__init__', { type: 'init', ts: Date.now() });
        log('worker', 'Topic 初始化消息已发送');
    } catch (initErr) {
        log('error', `Topic 初始化失败: ${initErr.message}. 降级到 SQLite 轮询模式。`);
        try { await consumer.disconnect(); } catch (_) {}
        consumer = null;
        return false;
    }

    try {
        await consumer.subscribe({ topic: TOPICS.OUTBOX, fromBeginning: false });
    } catch (subErr) {
        log('error', `Kafka subscribe 失败: ${subErr.message}. 降级到 SQLite 轮询模式。`);
        try { await consumer.disconnect(); } catch (_) {}
        consumer = null;
        return false;
    }

    try {
        await consumer.run({
            partitionsConsumedConcurrently: 3,
            eachMessage: async ({ message, heartbeat }) => {
                if (!running) return;

                const chatKey = message.key?.toString() || 'unknown';

                // 跳过初始化消息
                if (chatKey === '__init__') return;

                const retryCount = parseInt(message.headers?.retryCount?.toString() || '0', 10);

                let payloadData;
                try {
                    payloadData = JSON.parse(message.value.toString());
                } catch (parseErr) {
                    log('error', `${chatKey}: 无法解析消息载荷: ${parseErr.message}`);
                    return;
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
                        try {
                            await publishEvent(TOPICS.OUTBOX, chatKey, payloadData, {
                                retryCount: String(retryCount + 1),
                            });
                            log('retry', `${chatKey}: 重新入队 (retry ${retryCount + 1})`);
                        } catch (repubErr) {
                            log('error', `${chatKey}: 重新入队失败: ${repubErr.message}`);
                        }
                    }
                }
            },
        });
    } catch (runErr) {
        log('error', `Kafka consumer.run 失败: ${runErr.message}. 降级到 SQLite 轮询模式。`);
        try { await consumer.disconnect(); } catch (_) {}
        consumer = null;
        return false;
    }

    if (once) {
        await sleep(5000);
        await stop();
    }

    return true;
}

// ── 模式 B: SQLite 轮询（降级模式，修复 head-of-line blocking）─────────────

async function startSqliteWorker({ intervalMs = 3000, dryRun, once }) {
    log('worker', 'Starting SQLite Polling Auto-Reply Worker (降级模式)...');

    if (once) {
        await processSqliteOutbox({ dryRun });
        stop();
        return;
    }

    const loop = async () => {
        if (!running) return;
        try {
            await processSqliteOutbox({ dryRun });
        } catch (err) {
            log('error', `Worker loop error: ${err.message}`);
        }
        // 无论成功失败，固定间隔继续下一轮
        timeoutId = setTimeout(loop, intervalMs);
    };
    loop();
}

/**
 * SQLite 轮询处理：逐条处理，单条失败标记为已处理并跳过（不阻塞）。
 */
async function processSqliteOutbox({ dryRun = false } = {}) {
    const events = await db.getUnprocessedOutbox('new_messages', 5);
    if (events.length === 0) return 0;

    let processed = 0;

    for (const event of events) {
        if (!running) break;

        const { id, chat_key, payload } = event;
        let payloadData;
        try {
            payloadData = JSON.parse(payload || '{}');
        } catch {
            log('error', `Event #${id}: 无法解析 payload，跳过`);
            await db.markOutboxProcessed(id);
            processed++;
            continue;
        }

        try {
            await processEvent({ chatKey: chat_key, payloadData, dryRun });
            await db.markOutboxProcessed(id);
            processed++;
        } catch (err) {
            // 关键修复：失败时也标记为已处理，不阻塞后续消息
            log('error', `${chat_key}: LLM 调用失败 — ${err.message}. 标记为已处理，继续下一条。`);
            await db.markOutboxProcessed(id);
            processed++;
        }
    }

    return processed;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

async function startAutoReplyWorker({ intervalMs = 3000, dryRun = false, once = false } = {}) {
    if (running) return;
    running = true;

    log('worker', `  DRY_RUN:  ${dryRun}`);
    log('worker', `  ONCE:     ${once}`);

    // 优先 Kafka，不可用时降级 SQLite
    if (isKafkaAvailable()) {
        const ok = await startKafkaWorker({ dryRun, once });
        if (ok) return; // Kafka 模式启动成功
    }

    // 降级到 SQLite 轮询
    await startSqliteWorker({ intervalMs, dryRun, once });
}

async function stop() {
    if (!running) return;
    log('worker', 'Stopping Auto-Reply Worker...');
    running = false;
    if (consumer) {
        try { await consumer.disconnect(); } catch (_) { /* ignore */ }
        consumer = null;
    }
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

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
