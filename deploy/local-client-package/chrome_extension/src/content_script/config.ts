/**
 * config.ts — Content Script 全局配置常量
 *
 * 对应源文件 content_script.js 第 8-49 行的 CONFIG 对象，
 * 添加完整 TypeScript 类型注解。
 */

import type { Config } from './types';

/**
 * 全局运行配置。
 *
 * - 所有时间单位均为毫秒（Ms 后缀）。
 * - selectors 中的 CSS 类名来自闲鱼 IM 页面，可能随版本迭代变更。
 */
export const CONFIG: Config = {
    /** 从页面 header 提取的当前用户昵称（运行时填入） */
    userName: "",

    // --- 自动抓取配置 ---
    /** 是否启用自动抓取 */
    autoCrawl: true,
    /** 两次抓取之间的最小随机延迟（毫秒） */
    minDelay: 3000,
    /** 两次抓取之间的最大随机延迟（毫秒） */
    maxDelay: 5000,
    /** 单次抓取循环最大会话数上限 */
    maxCrawlLimit: 100,
    /** 启动就绪等待超时（毫秒） */
    startupReadyTimeoutMs: 20000,
    /** 启动就绪后额外延迟（毫秒） */
    startupPostReadyDelayMs: 1200,
    /** 初始会话同步的最大条数 */
    initialConversationSyncLimit: 30,
    /** 初始会话逐条点击延迟（毫秒） */
    initialConversationClickDelayMs: 1200,
    /** 初始会话逐条点击间隔（毫秒） */
    initialConversationBetweenDelayMs: 400,
    /** 未读消息轮询间隔（毫秒） */
    unreadWatchIntervalMs: 2000,
    /** 未读消息处理冷却时间（毫秒） */
    unreadHandleCooldownMs: 15000,
    /** 历史记录加载每步延迟（毫秒） */
    historyLoadStepDelayMs: 600,
    /** 历史记录加载最大滚动次数 */
    historyLoadMaxScrolls: 30,
    /** 历史记录加载最大持续时间（毫秒） */
    historyLoadMaxDurationMs: 20000,
    /** 状态保存防抖延迟（毫秒） */
    stateSaveDebounceMs: 500,
    /** 面板重绘防抖延迟（毫秒） */
    panelRenderDebounceMs: 250,
    /** 外发消息发送轮询间隔（毫秒） */
    senderPollIntervalMs: 1500,
    /** WSS 心跳间隔（毫秒） */
    heartbeatIntervalMs: 3000,
    /** 活跃会话同步间隔（毫秒） */
    activeSyncIntervalMs: 2500,
    /** 定位目标会话每步延迟（毫秒） */
    targetLocateStepDelayMs: 700,
    /** 定位目标会话最大滚动次数 */
    targetLocateMaxScrolls: 20,
    /** 定位目标会话最大持续时间（毫秒） */
    targetLocateMaxDurationMs: 15000,
    /** 打开目标会话超时（毫秒） */
    targetOpenTimeoutMs: 6000,

    // --- 通用配置 ---
    /** 控制台面板 DOM ID */
    panelId: 'xianyu-monitor-panel',
    /** localStorage 存储键名 */
    storageKey: 'xm_chat_history',
    /** 本地 WSS 端点 URL */
    apiWebSocketUrl: 'wss://127.0.0.1:3211/ws/browser',
    /** RPC 请求超时（毫秒） */
    apiRequestTimeoutMs: 10000,
    /** WSS 重连延迟（毫秒） */
    apiReconnectDelayMs: 1500,

    /** DOM 选择器配置（CSS 类名来自闲鱼 IM 页面，可能随版本迭代变更） */
    selectors: {
        myMessage: '.message-text-right--Vhy6k0cY',
        theirMessage: '.message-text-left--Wvuv8NsL',
        messageText: '.message-text--zV88pB7N',
        messageNode: '[class*="message-row--"]',
        imageContainer: '[class*="image-container--"]'
    }
};
