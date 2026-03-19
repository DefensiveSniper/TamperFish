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
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.vectortara.com';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.2';

const SIZE_RECOMMENDATION_RULES = Object.freeze({
    size_chart_type: 'recommendation_by_weight',
    weight_basis: 'jin',
    weight_unit: 'jin',
    weight_conversion: {
        from: 'kg',
        to: 'jin',
        rule: 'weight_jin = weight_kg * 2'
    },
    inventory_constraints: {
        max_available_size: '3XL',
        unavailable_sizes: ['4XL']
    },
    rules: [
        { weight_jin_min: 80, weight_jin_max: 90, recommended_size: 'S' },
        { weight_jin_min: 91, weight_jin_max: 103, recommended_size: 'M' },
        { weight_jin_min: 103, weight_jin_max: 113, recommended_size: 'L' },
        { weight_jin_min: 113, weight_jin_max: 122, recommended_size: 'XL' },
        { weight_jin_min: 122, weight_jin_max: 131, recommended_size: '2XL' },
        { weight_jin_min: 131, weight_jin_max: 140, recommended_size: '3XL' }
    ],
    notes: [
        '本尺码推荐按体重（斤）划分；若输入为公斤(kg)，需先乘以2换算为斤。',
        '当前库存最大到3XL，4XL无库存，故推荐规则不包含4XL。'
    ]
});

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
 * 将尺码推荐配置格式化为可注入 LLM 的 system prompt 文本。
 * @param {typeof SIZE_RECOMMENDATION_RULES} ruleConfig - 尺码推荐配置。
 * @returns {string} 供模型直接遵守的尺码规则说明。
 */
function buildSizeRecommendationPrompt(ruleConfig) {
    const recommendationLines = ruleConfig.rules.map(rule =>
        `- ${rule.weight_jin_min}-${rule.weight_jin_max}斤推荐 ${rule.recommended_size}`
    );
    const unavailableSizes = (ruleConfig.inventory_constraints?.unavailable_sizes || []).join('、');
    const noteLines = (ruleConfig.notes || []).map(note => `- ${note}`);

    return [
        '以下尺码推荐规则必须严格执行：',
        `- 尺码表类型：${ruleConfig.size_chart_type}`,
        `- 推荐依据：按体重（${ruleConfig.weight_unit}）推荐尺码`,
        `- 公斤换算规则：${ruleConfig.weight_conversion.rule}`,
        `- 当前最大可售尺码：${ruleConfig.inventory_constraints?.max_available_size || ''}`,
        `- 无库存尺码：${unavailableSizes || '无'}`,
        ...recommendationLines,
        ...noteLines,
        '- 如果买家问尺码、体重、斤、公斤、kg、穿多大等问题，优先按上述规则回答。',
        '- 如果买家直接问4XL，必须明确说明当前4XL无库存，最大到3XL。',
        '- 如果买家提供的是公斤，先换算成斤后再推荐。',
        '- 如果买家提供的信息不足或体重超出上述范围，不要瞎推荐，先让对方补充身高体重。'
    ].join('\n');
}

/**
 * 判断当前对话是否在询问尺码/体重相关问题。
 * @param {{role: string, content: string}[]} chatHistory - 当前聊天历史。
 * @returns {boolean} 是否需要注入尺码推荐规则。
 */
function shouldInjectSizeRecommendation(chatHistory = []) {
    const recentBuyerMessage = [...chatHistory]
        .reverse()
        .find(message => message.role === 'buyer' && message.content && (message.type || 'text') === 'text');
    if (!recentBuyerMessage) {
        return false;
    }

    return /尺码|码数|穿多大|多大码|体重|斤|公斤|kg|KG|xl|2xl|3xl|4xl|推荐.*码/.test(recentBuyerMessage.content);
}

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

    if (shouldInjectSizeRecommendation(chatHistory)) {
        messages.push({
            role: 'system',
            content: buildSizeRecommendationPrompt(SIZE_RECOMMENDATION_RULES)
        });
    }

    // Map chat history to OpenAI format
    // buyer → user, seller → assistant
    const recent = chatHistory.slice(-10); // last 10 messages
    for (const msg of recent) {
        const role = msg.role === 'buyer' ? 'user' : 'assistant';
        if ((msg.type || 'text') === 'image') {
            // 图片消息：传递图片URL供多模态模型理解
            messages.push({
                role,
                content: [
                    { type: 'image_url', image_url: { url: msg.content } },
                ],
            });
        } else {
            messages.push({ role, content: msg.content });
        }
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
