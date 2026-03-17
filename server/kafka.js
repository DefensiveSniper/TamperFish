'use strict';

/**
 * kafka.js — KafkaJS producer/consumer 封装
 *
 * 环境变量:
 *   KAFKA_BROKERS — Kafka broker 地址，逗号分隔 (默认 localhost:9092)
 *   KAFKA_CLIENT_ID — 客户端标识 (默认 goofish-server)
 */

const { Kafka, logLevel } = require('kafkajs');

const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'goofish-server';

const TOPICS = {
    OUTBOX: 'outbox-events',
    DLQ: 'outbox-events-dlq',
};

const kafka = new Kafka({
    clientId: CLIENT_ID,
    brokers: BROKERS,
    logLevel: logLevel.WARN,
    retry: {
        initialRetryTime: 300,
        retries: 5,
    },
});

// ── Singleton Producer ──────────────────────────────────────────────────────

let _producer = null;

async function getProducer() {
    if (_producer) return _producer;
    _producer = kafka.producer();
    await _producer.connect();
    console.log('[kafka] Producer connected');
    return _producer;
}

/**
 * 发布事件到指定 topic。
 * @param {string} topic - Kafka topic 名称。
 * @param {string} key - 消息 key（如 chat_key），同一 key 保证分区有序。
 * @param {object} value - 消息体（会被 JSON 序列化）。
 * @param {Record<string, string>} [headers] - 可选的消息 headers。
 */
async function publishEvent(topic, key, value, headers = {}) {
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

/**
 * 创建一个 Kafka consumer 实例。
 * @param {string} groupId - Consumer group ID。
 * @returns {import('kafkajs').Consumer}
 */
function createConsumer(groupId) {
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
    kafka,
    TOPICS,
    getProducer,
    publishEvent,
    createConsumer,
    disconnectProducer,
};
