'use strict';

/**
 * kafka.js — KafkaJS producer/consumer 封装（可选依赖）
 *
 * 如果 kafkajs 未安装或 Kafka broker 不可用，所有操作优雅降级（不崩溃）。
 *
 * 环境变量:
 *   KAFKA_BROKERS — Kafka broker 地址，逗号分隔 (默认 localhost:9092)
 *   KAFKA_CLIENT_ID — 客户端标识 (默认 goofish-server)
 */

const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'goofish-server';

const TOPICS = {
    OUTBOX: 'outbox-events',
    DLQ: 'outbox-events-dlq',
};

// 懒加载 kafkajs — 未安装时不崩溃
let _KafkaClass = null;
let _logLevel = null;
let _available = null; // null = 未检测, true/false

function isAvailable() {
    if (_available !== null) return _available;
    try {
        const mod = require('kafkajs');
        _KafkaClass = mod.Kafka;
        _logLevel = mod.logLevel;
        _available = true;
    } catch {
        _available = false;
        console.warn('[kafka] kafkajs 未安装，Kafka 功能不可用。运行 cd server && npm install kafkajs 启用。');
    }
    return _available;
}

let _kafka = null;
function getKafkaInstance() {
    if (_kafka) return _kafka;
    if (!isAvailable()) return null;
    _kafka = new _KafkaClass({
        clientId: CLIENT_ID,
        brokers: BROKERS,
        logLevel: _logLevel.WARN,
        retry: {
            initialRetryTime: 300,
            retries: 5,
        },
    });
    return _kafka;
}

// ── Singleton Producer ──────────────────────────────────────────────────────

let _producer = null;

async function getProducer() {
    if (_producer) return _producer;
    const kafka = getKafkaInstance();
    if (!kafka) throw new Error('kafkajs not installed');
    _producer = kafka.producer();
    await _producer.connect();
    console.log('[kafka] Producer connected');
    return _producer;
}

/**
 * 发布事件到指定 topic。
 * kafkajs 未安装时静默跳过。
 */
async function publishEvent(topic, key, value, headers = {}) {
    if (!isAvailable()) return; // 静默跳过
    const producer = await getProducer();
    const serializedHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
        serializedHeaders[k] = Buffer.from(String(v));
    }
    await producer.send({
        topic,
        messages: [{
            key,
            value: JSON.stringify(value),
            headers: serializedHeaders,
        }],
    });
}

// ── Consumer Factory ────────────────────────────────────────────────────────

function createConsumer(groupId) {
    const kafka = getKafkaInstance();
    if (!kafka) throw new Error('kafkajs not installed');
    return kafka.consumer({
        groupId,
        sessionTimeout: 30000,
        heartbeatInterval: 3000,
    });
}

// ── Disconnect ──────────────────────────────────────────────────────────────

async function disconnectProducer() {
    if (_producer) {
        await _producer.disconnect();
        _producer = null;
        console.log('[kafka] Producer disconnected');
    }
}

module.exports = {
    TOPICS,
    isAvailable,
    getProducer,
    publishEvent,
    createConsumer,
    disconnectProducer,
};
