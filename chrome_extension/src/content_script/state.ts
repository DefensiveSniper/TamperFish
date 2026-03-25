/**
 * state.ts — Content Script 全局状态与持久化
 *
 * 包含：
 * - `state` 对象初始化（从 localStorage 读取历史聊天记录）
 * - `browserApiState` WebSocket 连接状态初始化
 * - `saveState()` 立即落盘到 localStorage
 * - `scheduleStateSave()` 防抖版 saveState
 * - `schedulePanelRender()` 防抖版面板重绘（通过回调机制解耦 panel.ts 循环依赖）
 */

import { CONFIG } from './config';
import type { AppState, BrowserApiState } from './types';

// ---------------------------------------------------------------------------
// 从 localStorage 恢复历史聊天记录
// ---------------------------------------------------------------------------

let savedData: AppState['chats'] = {};
try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (raw) {
        savedData = JSON.parse(raw) as AppState['chats'];
    }
} catch (_) {
    // 读取失败时以空对象兜底，避免脚本崩溃
}

// ---------------------------------------------------------------------------
// 全局应用状态
// ---------------------------------------------------------------------------

/**
 * 全局应用状态对象。
 *
 * 通过 `window.xmState` 暴露，方便在 DevTools 中调试。
 * `crawlSuspendReasons` 与 `visitedThisCycle` 使用 Set，不会被序列化到 localStorage。
 */
export const state: AppState = {
    chats: savedData,
    currentKey: null,
    currentSessionId: null,
    currentSessionInfo: null,
    scrollPositions: {},
    collapsed: {},
    lastSaveTime: 0,
    crawlingDesiredEnabled: CONFIG.autoCrawl,
    isCrawling: CONFIG.autoCrawl,
    crawlSuspendReasons: new Set<string>(),
    visitedThisCycle: new Set<string>(),
    noNewItemsStreak: 0,
    crawledTotal: 0,
    statusText: '初始化...',
    isMinimized: false,
    sessionIndex: {},
    senderBusy: false,
    activeSyncBusy: false,
    initializationBusy: false,
    initializationCompleted: false,
    activeInitialCrawlNonce: null,
    lastHandledInitialCrawlNonce: null,
    unreadWatchBusy: false,
    unreadHandledAt: {}
};

// 暴露到 window 方便调试
(window as unknown as Record<string, unknown>).xmState = state;

// ---------------------------------------------------------------------------
// WSS 连接状态
// ---------------------------------------------------------------------------

/**
 * WebSocket 连接的运行时状态。
 * 由 api.ts 中的函数读写，此处集中初始化以避免循环依赖。
 */
export const browserApiState: BrowserApiState = {
    socket: null,
    connectPromise: null,
    reconnectTimer: null,
    nextRequestId: 0,
    pendingRequests: new Map(),
    manualClose: false
};

// ---------------------------------------------------------------------------
// 状态持久化
// ---------------------------------------------------------------------------

/** 防抖定时器句柄（null 表示当前无待执行的保存任务） */
let stateSaveTimer: number | null = null;

/** 面板重绘防抖定时器句柄（null 表示当前无待执行的重绘任务） */
let panelRenderTimer: number | null = null;

/**
 * 立即将当前聊天记录写入 localStorage。
 *
 * 只序列化 `state.chats`，Set 类型字段不参与序列化。
 */
export function saveState(): void {
    try {
        localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.chats));
        state.lastSaveTime = Date.now();
    } catch (_) {
        // 写入失败（如 quota 超限）时静默忽略
    }
}

/**
 * 将高频状态写入合并到一次本地存储落盘，避免初始化阶段频繁同步写 localStorage 卡住页面。
 *
 * 防抖延迟由 `CONFIG.stateSaveDebounceMs` 控制。
 */
export function scheduleStateSave(): void {
    if (stateSaveTimer !== null) {
        return;
    }

    stateSaveTimer = window.setTimeout(() => {
        stateSaveTimer = null;
        saveState();
    }, CONFIG.stateSaveDebounceMs);
}

// ---------------------------------------------------------------------------
// 面板重绘调度（回调机制，解耦 panel.ts 循环依赖）
// ---------------------------------------------------------------------------

/**
 * 面板重绘回调。
 *
 * panel.ts 初始化完成后应将 `renderPanel` 赋值给此变量，
 * 从而使 `schedulePanelRender` 能够触发实际的 DOM 重绘，
 * 同时避免 state.ts ↔ panel.ts 之间的循环 import。
 *
 * @example
 * // 在 panel.ts 中：
 * import { onPanelRenderScheduled } from './state';
 * onPanelRenderScheduled = renderPanel;
 */
export let onPanelRenderScheduled: (() => void) | null = null;

/**
 * 设置面板重绘回调（供 index.ts 在初始化时注册，避免循环 import）。
 * @param cb - 面板重绘函数（即 renderPanel）。
 */
export function setOnPanelRenderScheduled(cb: () => void): void {
    onPanelRenderScheduled = cb;
}

/**
 * 将监控面板重绘合并调度，避免启动初始化期间反复全量重渲染整个面板。
 *
 * 防抖延迟由 `CONFIG.panelRenderDebounceMs` 控制。
 * 若 `onPanelRenderScheduled` 尚未赋值，则本次调度静默忽略。
 */
export function schedulePanelRender(): void {
    if (panelRenderTimer !== null) {
        return;
    }

    panelRenderTimer = window.setTimeout(() => {
        panelRenderTimer = null;
        onPanelRenderScheduled?.();
    }, CONFIG.panelRenderDebounceMs);
}
