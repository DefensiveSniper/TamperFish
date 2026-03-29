/**
 * index.ts — Content Script 入口
 *
 * 对应 content_script.js 第 1939-2045 行。
 * 负责启动所有轮询循环、心跳同步和面板初始化。
 *
 * 注意：本文件运行在 world: "MAIN" 环境，不可使用任何 chrome.* API。
 * Vite/Rollup 以 format: 'iife' 构建时会自动包裹 IIFE，此处不需要手动写。
 */

import { CONFIG } from './config';
import { state, saveState, setOnPanelRenderScheduled } from './state';
import { connectBrowserApiSocket, closeBrowserApiSocket, browserApiRequest } from './api';
import { cleanupAnonymousDuplicateChats } from './sync';
import { createPanel, renderPanel } from './panel';
import { setCrawlingEnabled } from './panel';
import { startUnreadWatchLoop, startActiveConversationSyncLoop, runInitialConversationSync } from './crawler';
import { startSenderLoop } from './sender';
import { startSerialLoop } from './utils';
import type { HeartbeatResponse } from './types';

declare global {
    interface Window {
        __tamperfishRunInitialConversationSync?: (syncNonce: string, sessionCount?: number) => Promise<void>;
    }
}

// ---------------------------------------------------------------------------
// 心跳同步
// ---------------------------------------------------------------------------

/**
 * 向后端上报当前巡逻状态，并把 3210 期望的巡逻开关同步回本地脚本。
 * @returns Promise<void>
 */
async function syncCrawlerHeartbeat(): Promise<void> {
    try {
        const payload = (await browserApiRequest('browser.heartbeat', {
            crawlerEnabled: state.crawlingDesiredEnabled,
            currentChatKey: state.currentKey,
            currentSessionId: state.currentSessionId,
            initialCrawlNonceHandled: state.lastHandledInitialCrawlNonce,
        })) as HeartbeatResponse;

        if (
            typeof payload.crawlerDesiredEnabled === 'boolean' &&
            payload.crawlerDesiredEnabled !== state.crawlingDesiredEnabled
        ) {
            setCrawlingEnabled(payload.crawlerDesiredEnabled, 'remote-sync');
        }

        // 检查是否有新的初始遍历请求
        if (
            payload.initialCrawlNonce &&
            payload.initialCrawlNonce !== state.lastHandledInitialCrawlNonce &&
            payload.initialCrawlNonce !== state.activeInitialCrawlNonce &&
            !state.initializationBusy
        ) {
            runInitialConversationSync(
                payload.initialCrawlNonce,
                payload.initialCrawlSessionCount
            );
        }
    } catch (error) {
        const err = error as Error;
        console.warn('[XM] heartbeat failed:', err.message || error);
    }
}

/**
 * 启动浏览器脚本心跳与远程巡逻开关同步。
 */
function startHeartbeatLoop(): void {
    syncCrawlerHeartbeat();
    startSerialLoop(syncCrawlerHeartbeat, CONFIG.heartbeatIntervalMs, { immediate: false });
}

// ---------------------------------------------------------------------------
// 连接中断检测
// ---------------------------------------------------------------------------

/**
 * 定时检测闲鱼IM页面的"连接中断，请重连"弹窗，检测到后自动刷新页面。
 */
function startDisconnectDialogWatcher(): void {
    setInterval(() => {
        const modal = document.querySelector('.ant-modal');
        if (!modal) return;
        const title = modal.querySelector('.ant-modal-title');
        if (title && title.textContent?.includes('连接中断')) {
            console.warn('[XM] 检测到连接中断弹窗，自动刷新页面');
            location.reload();
        }
    }, 5000);
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

/**
 * Content Script 入口初始化函数。
 * 注册面板渲染回调、启动所有轮询循环，并（可选）创建内嵌浮窗面板。
 */
function init(): void {
    console.log('[XM] Starting...');

    // 注册面板重绘回调（解耦 state.ts ↔ panel.ts 循环依赖）
    setOnPanelRenderScheduled(renderPanel);

    // 自动从页面 header 提取当前用户昵称
    if (!CONFIG.userName) {
        const nickEl = document.querySelector<HTMLElement>(
            'a[href*="/personal"] .nick--RyNYtDXM, a[href*="/personal"] div[class*="nick--"]'
        );
        if (nickEl) {
            CONFIG.userName = nickEl.textContent?.trim() ?? '';
            console.log(`[XM] Auto-detected userName: ${CONFIG.userName}`);
        } else {
            console.warn(
                '[XM] Failed to auto-detect userName from header, customerName extraction may be inaccurate.'
            );
        }
    }

    connectBrowserApiSocket().catch((error: unknown) => {
        const err = error as Error;
        console.warn('[XM] browser api socket init failed:', err.message || error);
    });

    const cleanedCount = cleanupAnonymousDuplicateChats();
    if (cleanedCount > 0) {
        console.info(`[XM] cleaned ${cleanedCount} anonymous duplicate chat(s).`);
        saveState();
    }

    createPanel();
    renderPanel();

    window.__tamperfishRunInitialConversationSync = runInitialConversationSync;

    startHeartbeatLoop();
    startSenderLoop();
    startActiveConversationSyncLoop();
    startUnreadWatchLoop();
    startDisconnectDialogWatcher();
}

// ---------------------------------------------------------------------------
// 事件绑定与入口触发
// ---------------------------------------------------------------------------

window.addEventListener('beforeunload', closeBrowserApiSocket);

if (document.readyState === 'complete') {
    init();
} else {
    window.addEventListener('load', init);
}
