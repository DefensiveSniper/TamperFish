'use strict';

/**
 * ai.js — DeepSeek LLM 调用封装
 *
 * 用于闲鱼客服自动回复：将聊天历史 + 商品信息发给 LLM，获取纯文本回复。
 *
 * 环境变量:
 *   OPENAI_API_KEY   — API 密钥
 *   OPENAI_BASE_URL  — API 地址 (默认 http://api.deepseek.com)
 *   OPENAI_MODEL     — 模型名 (默认 deepseek-chat)
 *
 * 本地文件:
 *   ./ai.local.js    — 本机私有 API 密钥配置，优先级低于环境变量
 */

/**
 * 读取当前机器的本地 AI 配置。
 * 当本地配置文件不存在时返回空对象，便于继续使用环境变量。
 * @returns {{apiKey?: string}}
 */
function loadLocalAiConfig() {
    try {
        const localConfig = require('./ai.local');
        if (typeof localConfig.getLocalAiConfig === 'function') {
            return localConfig.getLocalAiConfig();
        }
        return localConfig || {};
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND' && /ai\.local/.test(error.message)) {
            return {};
        }
        throw error;
    }
}

const LOCAL_AI_CONFIG = loadLocalAiConfig();
const API_KEY = process.env.OPENAI_API_KEY || LOCAL_AI_CONFIG.apiKey || '';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.OPENAI_MODEL || 'deepseek-chat';

const SYSTEM_PROMPT = `你是一位友善、专业的闲鱼卖家客服。请遵守以下规则：

1. 用口语化、亲切的语气回复，像真人卖家一样。
2. 回复简洁（1-3 句话），不要太长。
3. 如果买家问价格，礼貌说明已经是最低价 / 可以小刀但幅度不大。
4. 如果买家问发货/快递，回复"拍下后 24 小时内发货，默认圆通/中通"。
5. 如果买家说"在吗"，回复"在的亲～有什么可以帮您？"。
6. 不要暴露你是 AI 或自动化系统。
7. 不要主动提及退款、投诉等敏感话题。
8. 如果遇到无法回答的问题，回复"稍等，我确认一下~"。`;

/**
 * 生成自动回复
 * @param {Array} chatHistory - [{role:'buyer'|'seller', content:string}]
 * @param {Object} productInfo - {price, location, url, id, userId}
 * @returns {Promise<string|null>} 回复文本, 或 null (不应回复)
 */
async function generateReply(chatHistory, productInfo = {}) {
    if (!API_KEY) {
        throw new Error('Missing OpenAI API key. Set OPENAI_API_KEY or create server/ai.local.js.');
    }

    // Build messages array
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    // Add product context
    if (productInfo && Object.keys(productInfo).length > 0) {
        const parts = [];
        if (productInfo.price) parts.push(`价格: ${productInfo.price}`);
        if (productInfo.location) parts.push(`发货地: ${productInfo.location}`);
        if (productInfo.url) parts.push(`链接: ${productInfo.url}`);
        if (productInfo.id) parts.push(`商品ID: ${productInfo.id}`);
        if (parts.length > 0) {
            messages.push({
                role: 'system',
                content: `当前商品信息：\n${parts.join('\n')}`
            });
        }
    }

    // Map chat history to OpenAI format
    // buyer → user, seller → assistant
    const recent = chatHistory.slice(-10); // last 10 messages
    for (const msg of recent) {
        messages.push({
            role: msg.role === 'buyer' ? 'user' : 'assistant',
            content: msg.content,
        });
    }

    // Call API
    const url = `${BASE_URL.replace(/\/$/, '')}/v1/chat/completions`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            model: MODEL,
            messages,
            max_tokens: 200,
            temperature: 0.7,
        }),
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`LLM API ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) return null;
    return reply;
}

module.exports = { generateReply, SYSTEM_PROMPT };
