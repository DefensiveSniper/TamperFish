// ==UserScript==
// @name         闲鱼消息监控与导出 (v4.2)
// @namespace    http://tampermonkey.net/
// @version      4.2
// @description  监控闲鱼网页版消息，支持精准发送、后台巡逻远程控制与数据持久化
// @author       XiaoWai
// @match        https://www.goofish.com/im*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '4.2';

    // --- 用户配置区 (User Configuration) ---
    const CONFIG = {
        userName: "",  // 从页面 header 提取的当前用户昵称

        // 自动抓取配置
        autoCrawl: true,
        minDelay: 3000,
        maxDelay: 5000,
        maxCrawlLimit: 100,
        startupReadyTimeoutMs: 20000,
        startupPostReadyDelayMs: 1200,
        initialConversationSyncLimit: 30,
        initialConversationClickDelayMs: 1200,
        initialConversationBetweenDelayMs: 400,
        unreadWatchIntervalMs: 2000,
        unreadHandleCooldownMs: 15000,
        historyLoadStepDelayMs: 600,
        historyLoadMaxScrolls: 30,
        historyLoadMaxDurationMs: 20000,
        stateSaveDebounceMs: 500,
        panelRenderDebounceMs: 250,
        senderPollIntervalMs: 1500,
        heartbeatIntervalMs: 3000,
        activeSyncIntervalMs: 2500,
        targetLocateStepDelayMs: 700,
        targetLocateMaxScrolls: 20,
        targetLocateMaxDurationMs: 15000,
        targetOpenTimeoutMs: 6000,

        panelId: 'xianyu-monitor-panel',
        storageKey: 'xm_chat_history',
        apiWebSocketUrl: 'wss://localhost:3211/ws/browser',
        apiRequestTimeoutMs: 10000,
        apiReconnectDelayMs: 1500,

        selectors: {
            myMessage: '.message-text-right--Vhy6k0cY',
            theirMessage: '.message-text-left--Wvuv8NsL',
            messageText: '.message-text--zV88pB7N',
            messageNode: '[class*="message-row--"]',
            imageContainer: '[class*="image-container--"]'
        }
    };
    // ------------------------------------

    console.log(`[XM] Script v${SCRIPT_VERSION} initialized.`);

    let savedData = {};
    try {
        const raw = localStorage.getItem(CONFIG.storageKey);
        if (raw) savedData = JSON.parse(raw);
    } catch (e) { }

    const state = {
        chats: savedData,
        currentKey: null,
        currentSessionId: null,
        currentSessionInfo: null,
        scrollPositions: {},
        collapsed: {},
        lastSaveTime: 0,
        crawlingDesiredEnabled: CONFIG.autoCrawl,
        isCrawling: CONFIG.autoCrawl,
        crawlSuspendReasons: new Set(),
        visitedThisCycle: new Set(),
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
    let stateSaveTimer = null;
    let panelRenderTimer = null;
    const browserApiState = {
        socket: null,
        connectPromise: null,
        reconnectTimer: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        manualClose: false
    };

    window.xmState = state;

    /**
     * 提供统一延时，供定位、发送和心跳轮询复用。
     * @param {number} ms - 等待毫秒数。
     * @returns {Promise<void>} 延时 Promise。
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 拒绝当前所有挂起的 WSS RPC 请求，避免连接断开后 Promise 永远悬挂。
     * @param {string} reason - 当前批量失败的原因。
     */
    function rejectPendingBrowserApiRequests(reason) {
        for (const [requestId, pending] of browserApiState.pendingRequests.entries()) {
            clearTimeout(pending.timerId);
            pending.reject(new Error(reason || `browser api request ${requestId} failed`));
        }
        browserApiState.pendingRequests.clear();
    }

    /**
     * 为浏览器脚本到本地服务的 WSS 连接安排一次延迟重连。
     * @param {string} reason - 触发本次重连的原因。
     */
    function scheduleBrowserApiReconnect(reason) {
        if (browserApiState.manualClose || browserApiState.reconnectTimer) {
            return;
        }

        browserApiState.reconnectTimer = window.setTimeout(() => {
            browserApiState.reconnectTimer = null;
            connectBrowserApiSocket().catch((error) => {
                console.warn('[XM] browser api socket reconnect failed:', reason, error.message || error);
            });
        }, CONFIG.apiReconnectDelayMs);
    }

    /**
     * 处理本地 WSS 服务返回的 RPC 响应，并把结果分发给对应的挂起请求。
     * @param {MessageEvent<string>} event - WebSocket message 事件。
     */
    function handleBrowserApiSocketMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (_) {
            return;
        }

        if (message?.type !== 'rpc-response' || message?.id == null) {
            return;
        }

        const pending = browserApiState.pendingRequests.get(String(message.id));
        if (!pending) {
            return;
        }

        clearTimeout(pending.timerId);
        browserApiState.pendingRequests.delete(String(message.id));

        if (message.ok) {
            pending.resolve(message.payload);
            return;
        }

        pending.reject(new Error(message.error || 'browser api request failed'));
    }

    /**
     * 建立到本地 Node 服务的单条 WSS 长连接。
     * 该连接只在页面生命周期内建立一次，后续所有浏览器脚本通信都复用它，不再走 HTTP。
     * @returns {Promise<WebSocket>} 已就绪的 WebSocket 连接。
     */
    function connectBrowserApiSocket() {
        if (browserApiState.socket && browserApiState.socket.readyState === WebSocket.OPEN) {
            return Promise.resolve(browserApiState.socket);
        }
        if (browserApiState.connectPromise) {
            return browserApiState.connectPromise;
        }

        browserApiState.manualClose = false;
        browserApiState.connectPromise = new Promise((resolve, reject) => {
            const socket = new WebSocket(CONFIG.apiWebSocketUrl);
            let settled = false;
            browserApiState.socket = socket;

            const failConnection = (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                browserApiState.connectPromise = null;
                if (browserApiState.socket === socket) {
                    browserApiState.socket = null;
                }
                reject(error instanceof Error ? error : new Error(String(error || 'browser api socket connect failed')));
                scheduleBrowserApiReconnect('connect-failed');
            };

            socket.addEventListener('open', () => {
                settled = true;
                browserApiState.connectPromise = null;
                resolve(socket);
            }, { once: true });

            socket.addEventListener('message', handleBrowserApiSocketMessage);
            socket.addEventListener('error', () => {
                if (!settled) {
                    failConnection(new Error('browser api socket error'));
                }
            });
            socket.addEventListener('close', () => {
                if (browserApiState.socket === socket) {
                    browserApiState.socket = null;
                }
                rejectPendingBrowserApiRequests('browser api socket closed');
                if (!settled) {
                    failConnection(new Error('browser api socket closed before open'));
                    return;
                }
                scheduleBrowserApiReconnect('closed');
            });
        });

        return browserApiState.connectPromise;
    }

    /**
     * 通过单条 WSS 长连接向本地服务发起一次 RPC 调用。
     * @param {string} action - RPC 动作名。
     * @param {Record<string, any>} payload - 请求负载。
     * @param {{ timeoutMs?: number }} options - 调用超时配置。
     * @returns {Promise<any>} 服务端返回的 payload。
     */
    async function browserApiRequest(action, payload = {}, options = {}) {
        const socket = await connectBrowserApiSocket();
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error('browser api socket is not open');
        }

        const requestId = String(++browserApiState.nextRequestId);
        const timeoutMs = options.timeoutMs || CONFIG.apiRequestTimeoutMs;
        return await new Promise((resolve, reject) => {
            const timerId = window.setTimeout(() => {
                browserApiState.pendingRequests.delete(requestId);
                reject(new Error(`browser api request timeout: ${action}`));
            }, timeoutMs);

            browserApiState.pendingRequests.set(requestId, {
                resolve,
                reject,
                timerId
            });

            try {
                socket.send(JSON.stringify({
                    type: 'rpc-request',
                    id: requestId,
                    action,
                    payload
                }));
            } catch (error) {
                clearTimeout(timerId);
                browserApiState.pendingRequests.delete(requestId);
                reject(error);
            }
        });
    }

    /**
     * 在页面卸载前主动关闭浏览器脚本到本地服务的 WSS 连接，避免重连计时器继续挂着。
     */
    function closeBrowserApiSocket() {
        browserApiState.manualClose = true;
        if (browserApiState.reconnectTimer) {
            clearTimeout(browserApiState.reconnectTimer);
            browserApiState.reconnectTimer = null;
        }
        rejectPendingBrowserApiRequests('browser api socket disposed');
        if (browserApiState.socket) {
            try {
                browserApiState.socket.close(1000, 'page unload');
            } catch (_) { }
            browserApiState.socket = null;
        }
        browserApiState.connectPromise = null;
    }

    /**
     * 归一化界面文案，去掉空白字符后再做按钮文本匹配。
     * @param {string} text - 原始界面文案。
     * @returns {string} 归一化后的文本。
     */
    function normalizeUiText(text) {
        return String(text || '').replace(/\s+/g, '').trim();
    }

    /**
     * 判断一个元素是否在页面中真实可见，避免命中隐藏按钮。
     * @param {Element | null} el - 待检测元素。
     * @returns {boolean} 是否可见。
     */
    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0';
    }

    /**
     * 查找当前聊天窗口真正的发送按钮。
     * 这里会先按可见按钮的归一化文案匹配“发送”，兼容“发 送”这类带空格的按钮文本。
     * @returns {HTMLElement | null} 找到的发送按钮。
     */
    function findSendButtonElement() {
        const textMatchedButton = Array.from(document.querySelectorAll('button'))
            .find(button => isElementVisible(button) && normalizeUiText(button.textContent) === '发送');
        if (textMatchedButton) {
            return textMatchedButton;
        }

        return Array.from(document.querySelectorAll('button[class*="send"], .send-btn, [data-testid*="send"]'))
            .find(isElementVisible) || null;
    }

    function saveState() {
        try {
            localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.chats));
            state.lastSaveTime = Date.now();
        } catch (e) { }
    }

    /**
     * 将高频状态写入合并到一次本地存储落盘，避免初始化阶段频繁同步写 localStorage 卡住页面。
     */
    function scheduleStateSave() {
        if (stateSaveTimer) {
            return;
        }

        stateSaveTimer = window.setTimeout(() => {
            stateSaveTimer = null;
            saveState();
        }, CONFIG.stateSaveDebounceMs);
    }

    /**
     * 将监控面板重绘合并调度，避免启动初始化期间反复全量重渲染整个面板。
     */
    function schedulePanelRender() {
        if (panelRenderTimer) {
            return;
        }

        panelRenderTimer = window.setTimeout(() => {
            panelRenderTimer = null;
            renderPanel();
        }, CONFIG.panelRenderDebounceMs);
    }

    /**
     * 基于买家名与商品 ID 生成稳定的 chatKey。
     * @param {string} customerName - 买家名。
     * @param {string|null|undefined} productId - 商品 ID。
     * @returns {string} 归一化后的会话键。
     */
    function buildChatKey(customerName, productId) {
        return customerName + (productId ? `_${productId}` : '');
    }

    /**
     * 判断两组消息是否为同一条会话快照。
     * @param {{content: string, isMe: boolean, type?: string}[]} left
     * @param {{content: string, isMe: boolean, type?: string}[]} right
     * @returns {boolean} 是否逐条完全一致。
     */
    function areMessagesEquivalent(left = [], right = []) {
        if (left.length !== right.length) return false;
        for (let i = 0; i < left.length; i++) {
            if ((left[i]?.content || '') !== (right[i]?.content || '')) return false;
            if (!!left[i]?.isMe !== !!right[i]?.isMe) return false;
            if ((left[i]?.type || 'text') !== (right[i]?.type || 'text')) return false;
        }
        return true;
    }

    /**
     * 合并两份商品信息，优先保留更完整的字段。
     * @param {Record<string, any>} preferred - 当前新提取到的商品信息。
     * @param {Record<string, any>} fallback - 历史缓存中的商品信息。
     * @returns {Record<string, any>} 合并后的商品对象。
     */
    function mergeProductInfo(preferred = {}, fallback = {}) {
        return {
            price: preferred.price || fallback.price || '',
            location: preferred.location || fallback.location || '',
            url: preferred.url || fallback.url || '',
            id: preferred.id || fallback.id || null,
            userId: preferred.userId || fallback.userId || null
        };
    }

    /**
     * 根据消息快照查找同买家下的完整会话键，用于把“无 ID 副本”并回真实会话。
     * @param {string} customerName - 当前买家名。
     * @param {{content: string, isMe: boolean}[]} messages - 当前右侧提取到的消息快照。
     * @returns {string|null} 匹配到的完整会话键；未命中则返回 null。
     */
    function findCanonicalChatKey(customerName, messages) {
        const matches = Object.entries(state.chats).filter(([key, chat]) => {
            if (!key.includes('_')) return false;
            const chatCustomerName = chat?.customerName || key.split('_')[0];
            if (chatCustomerName !== customerName) return false;
            if (!chat?.productId) return false;
            return areMessagesEquivalent(chat.messages || [], messages || []);
        });
        return matches.length === 1 ? matches[0][0] : null;
    }

    /**
     * 将旧的无 ID 副本会话合并到目标会话，并删除副本键。
     * @param {string} sourceKey - 待删除的副本键。
     * @param {string} targetKey - 最终保留的真实会话键。
     * @param {{ customerName: string, productId: string|null, buyerUserId?: string|null, product: Record<string, any>, messages: {content: string, isMe: boolean}[] }} incomingChat - 本轮新提取的会话快照。
     * @returns {boolean} 是否发生了合并。
     */
    function mergeDuplicateChatState(sourceKey, targetKey, incomingChat) {
        if (!sourceKey || !targetKey || sourceKey === targetKey) return false;
        const sourceChat = state.chats[sourceKey];
        if (!sourceChat) return false;

        const targetChat = state.chats[targetKey] || {
            customerName: incomingChat.customerName,
            productId: incomingChat.productId || null,
            messages: [],
            product: {},
            buyerUserId: incomingChat.buyerUserId || null,
            sessionId: incomingChat.sessionId || null,
            sessionInfo: incomingChat.sessionInfo || null
        };

        const sourceMessages = sourceChat.messages || [];
        const targetMessages = targetChat.messages || [];
        const mergedMessages = incomingChat.messages.length >= targetMessages.length
            ? incomingChat.messages
            : (targetMessages.length >= sourceMessages.length ? targetMessages : sourceMessages);

        state.chats[targetKey] = {
            customerName: incomingChat.customerName || targetChat.customerName || sourceChat.customerName || targetKey.split('_')[0],
            productId: incomingChat.productId || targetChat.productId || sourceChat.productId || null,
            messages: mergedMessages,
            product: mergeProductInfo(incomingChat.product, mergeProductInfo(targetChat.product, sourceChat.product)),
            buyerUserId: incomingChat.buyerUserId || targetChat.buyerUserId || sourceChat.buyerUserId || null,
            sessionId: incomingChat.sessionId || targetChat.sessionId || sourceChat.sessionId || null,
            sessionInfo: incomingChat.sessionInfo || targetChat.sessionInfo || sourceChat.sessionInfo || null
        };

        delete state.chats[sourceKey];
        delete state.collapsed[sourceKey];
        delete state.scrollPositions[sourceKey];

        if (state.currentKey === sourceKey) {
            state.currentKey = targetKey;
        }

        return true;
    }

    /**
     * 清理本地缓存里已经存在的无 ID 重复会话，避免它们继续被 sync.js 同步到后端。
     * @returns {number} 被合并删除的副本数量。
     */
    function cleanupAnonymousDuplicateChats() {
        let cleaned = 0;
        for (const [chatKey, chat] of Object.entries({ ...state.chats })) {
            if (!chat || chatKey.includes('_') || chat.productId) continue;
            const customerName = chat.customerName || chatKey;
            const canonicalKey = findCanonicalChatKey(customerName, chat.messages || []);
            if (!canonicalKey) continue;
            if (mergeDuplicateChatState(chatKey, canonicalKey, {
                customerName,
                productId: state.chats[canonicalKey]?.productId || null,
                buyerUserId: state.chats[canonicalKey]?.buyerUserId || chat.buyerUserId || null,
                product: mergeProductInfo(state.chats[canonicalKey]?.product || {}, chat.product || {}),
                messages: chat.messages || []
            })) {
                cleaned++;
            }
        }
        return cleaned;
    }

    /**
     * 将当前提取结果写回到指定会话键，并返回是否有实际变化。
     * @param {string} chatKey - 目标会话键。
     * @param {{ customerName: string, productId: string|null, buyerUserId?: string|null, product: Record<string, any>, messages: {content: string, isMe: boolean}[] }} incomingChat - 当前提取结果。
     * @returns {boolean} 是否更新了缓存内容。
     */
    function syncChatState(chatKey, incomingChat) {
        const existingChat = state.chats[chatKey];
        if (!existingChat) {
            state.chats[chatKey] = {
                customerName: incomingChat.customerName,
                productId: incomingChat.productId || null,
                messages: incomingChat.messages || [],
                product: mergeProductInfo(incomingChat.product, {}),
                buyerUserId: incomingChat.buyerUserId || null,
                sessionId: incomingChat.sessionId || null,
                sessionInfo: incomingChat.sessionInfo || null
            };
            state.collapsed[chatKey] = true;
            return true;
        }

        let changed = false;
        const mergedProduct = mergeProductInfo(incomingChat.product, existingChat.product || {});
        if (JSON.stringify(mergedProduct) !== JSON.stringify(existingChat.product || {})) {
            existingChat.product = mergedProduct;
            changed = true;
        }
        if (incomingChat.productId && existingChat.productId !== incomingChat.productId) {
            existingChat.productId = incomingChat.productId;
            changed = true;
        }
        if (incomingChat.customerName && existingChat.customerName !== incomingChat.customerName) {
            existingChat.customerName = incomingChat.customerName;
            changed = true;
        }
        if (incomingChat.buyerUserId && existingChat.buyerUserId !== incomingChat.buyerUserId) {
            existingChat.buyerUserId = incomingChat.buyerUserId;
            changed = true;
        }
        if (incomingChat.sessionId && existingChat.sessionId !== incomingChat.sessionId) {
            existingChat.sessionId = incomingChat.sessionId;
            changed = true;
        }
        if (incomingChat.sessionInfo) {
            const previousSessionInfo = JSON.stringify(existingChat.sessionInfo || {});
            const nextSessionInfo = JSON.stringify(incomingChat.sessionInfo);
            if (previousSessionInfo !== nextSessionInfo) {
                existingChat.sessionInfo = incomingChat.sessionInfo;
                changed = true;
            }
        }
        if ((incomingChat.messages || []).length > 0 && !areMessagesEquivalent(incomingChat.messages, existingChat.messages || [])) {
            existingChat.messages = incomingChat.messages;
            changed = true;
        }
        return changed;
    }

    /**
     * 从 React 会话对象中提取可序列化的最小路由信息，避免把整棵 React 树写入本地缓存。
     * @param {any} sessionInfo - 原始会话对象。
     * @returns {Record<string, any> | null} 精简后的会话信息。
     */
    function normalizeSessionInfo(sessionInfo) {
        if (!sessionInfo || !sessionInfo.sessionId) {
            return null;
        }

        return {
            sessionId: String(sessionInfo.sessionId),
            sessionType: sessionInfo.sessionType ?? null,
            targetUrlSessionInfo: sessionInfo.targetUrlSessionInfo || null,
            itemInfo: sessionInfo.itemInfo ? {
                itemId: sessionInfo.itemInfo.itemId != null ? String(sessionInfo.itemInfo.itemId) : '',
                title: sessionInfo.itemInfo.title || '',
                sellerInfo: sessionInfo.itemInfo.sellerInfo ? {
                    userId: sessionInfo.itemInfo.sellerInfo.userId != null
                        ? String(sessionInfo.itemInfo.sellerInfo.userId)
                        : ''
                } : null
            } : null,
            ownerInfo: sessionInfo.ownerInfo ? {
                userId: sessionInfo.ownerInfo.userId != null ? String(sessionInfo.ownerInfo.userId) : ''
            } : null,
            userInfo: sessionInfo.userInfo ? {
                userId: sessionInfo.userInfo.userId != null ? String(sessionInfo.userInfo.userId) : '',
                nick: sessionInfo.userInfo.nick || '',
                fishNick: sessionInfo.userInfo.fishNick || ''
            } : null,
            summary: sessionInfo.summary ? {
                latestMessage: sessionInfo.summary.latestMessage ? {
                    messageId: sessionInfo.summary.latestMessage.messageId || '',
                    sessionId: sessionInfo.summary.latestMessage.sessionId != null
                        ? String(sessionInfo.summary.latestMessage.sessionId)
                        : ''
                } : null
            } : null
        };
    }

    /**
     * 递归扫描会话项的 React 树，提取其中的 sessionInfo。
     * @param {HTMLElement | null} itemEl - 左侧会话项 DOM。
     * @returns {Record<string, any> | null} 归一化后的会话信息。
     */
    function extractSessionInfoFromConversationItem(itemEl) {
        if (!itemEl) return null;

        const candidates = [];
        Object.keys(itemEl).forEach((key) => {
            if (key.startsWith('__reactFiber') || key.startsWith('__reactProps')) {
                candidates.push(itemEl[key]);
            }
        });

        const seen = new Set();
        while (candidates.length > 0) {
            const current = candidates.shift();
            if (!current || typeof current !== 'object' || seen.has(current)) {
                continue;
            }
            seen.add(current);

            const maybeSessionInfo = current.sessionInfo
                || current.pendingProps?.sessionInfo
                || current.memoizedProps?.sessionInfo;
            const normalized = normalizeSessionInfo(maybeSessionInfo);
            if (normalized) {
                return normalized;
            }

            for (const key of Object.keys(current).slice(0, 30)) {
                const value = current[key];
                if (!value || typeof value !== 'object') continue;
                if (value.nodeType || value.ownerDocument) continue;
                candidates.push(value);
            }
        }

        return null;
    }

    /**
     * 扫描当前可见会话列表，建立基于 session_id 的会话索引。
     * @returns {{ itemEl: HTMLElement, sessionId: string, sessionInfo: Record<string, any>, title: string, productId: string, isActive: boolean }[]} 当前可见会话元数据。
     */
    function buildVisibleConversationEntries() {
        const entries = [];
        for (const itemEl of getSidebarItems()) {
            const sessionInfo = extractSessionInfoFromConversationItem(itemEl);
            if (!sessionInfo?.sessionId) continue;

            const title = (itemEl.innerText || '').split('\n')[0].trim();
            const productId = sessionInfo.itemInfo?.itemId ? String(sessionInfo.itemInfo.itemId) : '';
            const entry = {
                itemEl,
                sessionId: sessionInfo.sessionId,
                sessionInfo,
                title,
                productId,
                isActive: itemEl.className.includes('conversation-item-active')
            };

            state.sessionIndex[entry.sessionId] = {
                sessionInfo,
                title,
                productId,
                seenAt: Date.now()
            };
            entries.push(entry);
        }
        return entries;
    }

    /**
     * 返回当前已激活会话的 session_id。
     * @returns {string|null} 当前激活的会话 ID。
     */
    function getCurrentActiveSessionId() {
        const activeItem = getSidebarItems().find(item => item.className.includes('conversation-item-active'));
        const activeSessionInfo = extractSessionInfoFromConversationItem(activeItem);
        return activeSessionInfo?.sessionId || state.currentSessionId || null;
    }

    /**
     * 渲染油猴面板中的巡逻按钮文案和颜色。
     * 这里展示的是“期望状态”，而不是发送期的瞬时暂停状态。
     */
    function renderCrawlToggleButton() {
        const toggleBtn = document.getElementById('xm-crawl-toggle');
        if (!toggleBtn) return;
        toggleBtn.innerText = state.crawlingDesiredEnabled ? '⏸ 暂停' : '▶️ 自动';
        toggleBtn.style.background = state.crawlingDesiredEnabled ? '#ffaaaa' : '#e0ffe0';
    }

    /**
     * 将巡逻开关、远程同步和临时挂起统一收敛到一个状态机。
     * @param {boolean} nextValue - 目标状态；临时挂起模式下表示是否解除挂起。
     * @param {string} reason - 触发本次状态变化的原因。
     * @param {{ transient?: boolean }} options - 状态机配置。
     */
    function setCrawlingEnabled(nextValue, reason, options = {}) {
        const { transient = false } = options;
        const wasCrawling = state.isCrawling;

        if (transient) {
            if (nextValue) {
                state.crawlSuspendReasons.delete(reason);
            } else {
                state.crawlSuspendReasons.add(reason);
            }
        } else {
            state.crawlingDesiredEnabled = !!nextValue;
        }

        state.isCrawling = state.crawlingDesiredEnabled && state.crawlSuspendReasons.size === 0;
        renderCrawlToggleButton();

        if (transient) {
            state.statusText = state.isCrawling ? '恢复巡逻...' : '发送中，遍历暂挂...';
        } else {
            state.statusText = state.crawlingDesiredEnabled ? '恢复巡逻...' : '已暂停';
        }
        renderFooter();

        if (!wasCrawling && state.isCrawling) {
            crawlNext();
        }
    }

    /**
     * 将本地巡逻期望状态同步到后端设置表，供 3210 UI 远程展示与控制。
     * @param {boolean} nextValue - 期望的新状态。
     * @returns {Promise<void>}
     */
    async function persistCrawlerDesiredState(nextValue) {
        try {
            await browserApiRequest('settings.patch', {
                crawlerDesiredEnabled: nextValue
            });
        } catch (error) {
            console.warn('[XM] persist crawler desired state failed:', error.message || error);
        }
    }

    // --- UI ---
    function createPanel() {
        if (document.getElementById(CONFIG.panelId)) return;

        const panel = document.createElement('div');
        panel.id = CONFIG.panelId;
        panel.style.cssText = `
            position: fixed; right: 20px; top: 20px; width: 360px; height: 90vh;
            background: #fff; box-shadow: 0 4px 20px rgba(0,0,0,0.15); z-index: 999999;
            display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            border-radius: 12px; overflow: hidden; transition: all 0.3s ease;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            padding: 15px; background: #ffda44; font-weight: bold; color: #333;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid rgba(0,0,0,0.05);
        `;

        header.innerHTML = `
            <div style="display:flex;align-items:center;gap:5px;">
                <span>🐟 监控台 v${SCRIPT_VERSION}</span>
            </div>
            <div style="display:flex;gap:8px;">
                <button id="xm-crawl-toggle" style="padding:4px 8px;font-size:12px;cursor:pointer;background:${state.crawlingDesiredEnabled ? '#ffaaaa' : '#e0ffe0'};border:none;border-radius:4px;font-weight:bold;">${state.crawlingDesiredEnabled ? '⏸ 暂停' : '▶️ 自动'}</button>
                <button id="xm-clear" style="padding:4px 8px;font-size:12px;cursor:pointer;background:rgba(255,255,255,0.5);border:none;border-radius:4px;color:#d00;" title="清空">🗑</button>
                <button id="xm-min" style="padding:4px 8px;font-size:12px;cursor:pointer;background:rgba(255,255,255,0.5);border:none;border-radius:4px;" title="最小化">_</button>
            </div>
        `;

        const content = document.createElement('div');
        content.id = 'xm-content';
        content.style.cssText = `flex: 1; overflow-y: auto; padding: 15px; background: #f7f7f7;`;

        const footer = document.createElement('div');
        footer.id = 'xm-footer';
        footer.style.cssText = `padding: 8px; font-size: 11px; color: #888; background: #fff; border-top: 1px solid #eee; text-align: center;`;
        footer.innerText = '准备就绪';

        panel.appendChild(header);
        panel.appendChild(content);
        panel.appendChild(footer);
        document.body.appendChild(panel);

        header.querySelector('#xm-crawl-toggle').onclick = async () => {
            const nextValue = !state.crawlingDesiredEnabled;
            setCrawlingEnabled(nextValue, 'panel-click');
            await persistCrawlerDesiredState(nextValue);
        };

        header.querySelector('#xm-clear').onclick = () => {
            state.chats = {};
            state.visitedThisCycle.clear();
            state.noNewItemsStreak = 0;
            localStorage.removeItem(CONFIG.storageKey);
            renderPanel();
        };

        const minBtn = header.querySelector('#xm-min');
        const toggleBtn = header.querySelector('#xm-crawl-toggle');
        renderCrawlToggleButton();
        minBtn.onclick = () => {
            state.isMinimized = !state.isMinimized;
            if (state.isMinimized) {
                panel.style.height = '50px'; panel.style.width = '200px';
                content.style.display = 'none'; footer.style.display = 'none';
                minBtn.innerText = '□'; toggleBtn.style.display = 'none';
            } else {
                panel.style.height = '90vh'; panel.style.width = '360px';
                content.style.display = 'block'; footer.style.display = 'block';
                minBtn.innerText = '_'; toggleBtn.style.display = 'inline-block';
            }
        };

        content.addEventListener('click', (e) => {
            if (e.target.classList.contains('xm-collapse-btn') || e.target.closest('.xm-collapse-btn')) {
                const btn = e.target.classList.contains('xm-collapse-btn') ? e.target : e.target.closest('.xm-collapse-btn');
                const key = btn.dataset.key;
                state.collapsed[key] = !state.collapsed[key];
                renderPanel();
            }
        });
    }

    function renderPanel() {
        const content = document.getElementById('xm-content');
        if (!content) return;
        const mainScrollTop = content.scrollTop;
        const chatBoxes = content.querySelectorAll('.xm-chat-box-messages');
        chatBoxes.forEach(box => {
            const key = box.getAttribute('data-key');
            if (key) state.scrollPositions[key] = box.scrollTop;
        });

        const chatKeys = Object.keys(state.chats).filter(k =>
            k !== 'Unknown' && k !== '通知消息' && state.chats[k].messages.length > 0
        );

        if (chatKeys.length === 0) {
            content.innerHTML = '<div style="text-align:center;color:#999;margin-top:40px;">暂无聊天记录</div>';
        } else {
            content.innerHTML = '';
            chatKeys.forEach(key => {
                const chat = state.chats[key];
                const isCurrent = state.currentKey === key;
                const isCollapsed = state.collapsed[key] !== false;

                const chatBox = document.createElement('div');
                chatBox.style.cssText = `
                    background: white; margin-bottom: 12px; border-radius: 8px;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.04); overflow: hidden;
                    border: 2px solid ${isCurrent ? '#ffda44' : 'transparent'};
                `;

                let productHtml = '';
                if (!isCollapsed && chat.product && (chat.product.price || chat.product.location)) {
                    productHtml = `
                        <div style="padding:10px 12px;background:#fff9e6;border-bottom:1px solid #f0e6cc;font-size:12px;display:flex;align-items:center;">
                            <div style="flex:1;">
                                <div style="color:#ff5000;font-weight:bold;font-size:14px;">${chat.product.price || '价格未知'}</div>
                                <div style="color:#888;font-size:11px;margin-top:2px;">${chat.product.location || ''}</div>
                            </div>
                            ${chat.product.url ? `<a href="${chat.product.url}" target="_blank" style="color:#00a1d6;text-decoration:none;background:#fff;padding:2px 8px;border-radius:10px;border:1px solid #00a1d6;font-size:11px;">宝贝 ></a>` : ''}
                        </div>
                    `;
                }

                const displayName = chat.customerName || key.split('_')[0] || 'Unknown';

                let messagesHtml = '';
                if (!isCollapsed) {
                    messagesHtml = `
                        <div class="xm-chat-box-messages" data-key="${key}" style="padding:12px;max-height:300px;overflow-y:auto;background:#fafafa;">
                            ${chat.messages.map(m => `
                                <div style="margin-bottom: 8px; display: flex; flex-direction: column; align-items: ${m.isMe ? 'flex-end' : 'flex-start'};">
                                    <div style="font-size:10px;color:#bbb;margin-bottom:3px;margin-${m.isMe ? 'right' : 'left'}:4px;">${m.isMe ? '我' : displayName}</div>
                                    <div style="
                                        max-width: 85%; padding: 8px 12px; border-radius: 12px;
                                        background: ${m.isMe ? '#ffda44' : '#fff'};
                                        color: ${m.isMe ? '#000' : '#333'};
                                        font-size: 13px; line-height: 1.4;
                                        border: ${m.isMe ? 'none' : '1px solid #e0e0e0'};
                                        word-wrap: break-word; white-space: pre-wrap;
                                        box-shadow: 0 1px 2px rgba(0,0,0,0.03);
                                    ">${escapeHtml(m.content)}</div>
                                </div>
                            `).join('') || '<div style="text-align:center;color:#ddd;padding:10px;">暂无消息</div>'}
                        </div>
                    `;
                }

                const titleHtml = `
                    <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;width:100%;" class="xm-collapse-btn" data-key="${key}">
                        <div style="display:flex;align-items:center;gap:5px;pointer-events:none;">
                            <span style="color:#999;font-size:10px;">${isCollapsed ? '▶' : '▼'}</span>
                            <span>👤 ${escapeHtml(displayName)}</span>
                            ${chat.productId ? `<span style="font-size:10px;background:#eee;padding:2px 5px;border-radius:4px;color:#666;">ID:${chat.productId.slice(-4)}</span>` : ''}
                        </div>
                        <span style="font-size:10px;color:#999;pointer-events:none;">${chat.messages.length}条</span>
                    </div>
                `;

                chatBox.innerHTML = `
                    <div style="padding:10px 12px;background:#fff;border-bottom:${isCollapsed ? 'none' : '1px solid #f7f7f7'};font-weight:600;color:#333;font-size:14px;">
                        ${titleHtml}
                    </div>
                    ${productHtml}
                    ${messagesHtml}
                `;
                content.appendChild(chatBox);
            });
            content.scrollTop = mainScrollTop;
            const newChatBoxes = content.querySelectorAll('.xm-chat-box-messages');
            newChatBoxes.forEach(box => {
                const key = box.getAttribute('data-key');
                if (key && state.scrollPositions[key] !== undefined) box.scrollTop = state.scrollPositions[key];
            });
        }
        renderFooter();
    }

    function renderFooter() {
        const footer = document.getElementById('xm-footer');
        if (footer) footer.innerText = `${state.statusText} | 会话: ${Object.keys(state.chats).length}`;
    }

    function escapeHtml(text) { return text ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ''; }

    // --- Crawler ---
    function getSidebarContainer() {
        return document.querySelector('.rc-virtual-list-holder') || document.querySelector('div[class*="virtual-list"]');
    }
    function getSidebarItems() {
        const container = document.querySelector('.rc-virtual-list-holder-inner');
        if (container) return Array.from(container.children).filter(c => c.tagName === 'DIV');
        return [];
    }

    /**
     * 归一化左侧会话项的文本，尽量去掉时间和未读数这类易变内容。
     * @param {string} text - 左侧会话项原始文本。
     * @returns {string[]} 归一化后的文本行数组。
     */
    function normalizeSidebarLines(text) {
        return (text || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => !/^\d+$/.test(line))
            .filter(line => !/^(刚刚|昨天|前天|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)$/u.test(line));
    }

    /**
     * 为左侧会话项生成遍历用唯一键，避免同名买家在一轮巡逻中互相覆盖。
     * @param {HTMLElement} item - 当前左侧会话项节点。
     * @param {Map<string, number>} occurrenceMap - 当前可见区域内的签名计数器。
     * @returns {{ title: string, visitKey: string }} 会话标题与遍历键。
     */
    function getItemIdentifier(item, occurrenceMap) {
        const titleEl = item.querySelector('.title-box--xH34x78G');
        const title = titleEl ? titleEl.innerText.trim() : item.innerText.split('\n')[0].trim();
        const normalizedLines = normalizeSidebarLines(item.innerText);
        const descriptor = normalizedLines.slice(1).join(' | ');
        const baseKey = `${title}||${descriptor || 'no-descriptor'}`;
        const occurrence = (occurrenceMap.get(baseKey) || 0) + 1;
        occurrenceMap.set(baseKey, occurrence);

        return {
            title,
            visitKey: `${baseKey}##${occurrence}`
        };
    }

    /**
     * 判断当前是否处于人工输入状态，避免初始化/未读处理打断手工操作。
     * @returns {boolean} 当前是否正在输入消息。
     */
    function isUserTypingMessage() {
        const activeEl = document.activeElement;
        return !!activeEl && (
            activeEl.tagName === 'TEXTAREA'
            || activeEl.getAttribute('contenteditable') === 'true'
        );
    }

    /**
     * 读取当前右侧会话标题，用于判断 React 是否已经切换到目标会话。
     * @returns {string} 当前右侧会话标题；未命中时返回空串。
     */
    function readCurrentConversationName() {
        const main = document.querySelector('div[role="main"]') || document.querySelector('main');
        if (!main) {
            return '';
        }

        const headerEl = main.querySelector('div');
        if (!headerEl) {
            return '';
        }

        const nameCandidate = headerEl.innerText.split('\n')[0];
        if (!nameCandidate || nameCandidate.includes(CONFIG.userName) || nameCandidate === '消息') {
            return '';
        }

        return nameCandidate.trim();
    }

    /**
     * 等待右侧会话窗口完成切换。
     * @param {string|null} expectedCustomerName - 期望切换到的买家名；为空时只要求会话窗口已可读。
     * @returns {Promise<boolean>} 是否在超时前等到目标会话。
     */
    async function waitForConversationRender(expectedCustomerName = null) {
        const deadline = Date.now() + CONFIG.targetOpenTimeoutMs;
        while (Date.now() < deadline) {
            const currentConversationName = readCurrentConversationName();
            if (currentConversationName && (!expectedCustomerName || currentConversationName === expectedCustomerName)) {
                return true;
            }
            await sleep(250);
        }
        return false;
    }

    /**
     * 等待闲鱼 IM 左右两栏完成首屏渲染，避免脚本在页面尚未稳定时就启动重采集。
     * @returns {Promise<boolean>} 是否在超时前等到聊天工作区就绪。
     */
    async function waitForChatWorkspaceReady() {
        const deadline = Date.now() + CONFIG.startupReadyTimeoutMs;
        while (Date.now() < deadline) {
            const main = document.querySelector('div[role="main"]') || document.querySelector('main');
            const sidebar = getSidebarContainer();
            if (main && sidebar) {
                return true;
            }
            await sleep(300);
        }
        return false;
    }

    /**
     * 返回当前右侧聊天窗口里已经渲染出来的消息节点。
     * @param {ParentNode | null} root - 查询根节点；为空时默认使用当前主会话区。
     * @returns {HTMLElement[]} 当前渲染的消息节点。
     */
    function getRenderedMessageNodes(root = null) {
        const main = root || document.querySelector('div[role="main"]') || document.querySelector('main');
        if (!main) {
            return [];
        }

        return Array.from(main.querySelectorAll(CONFIG.selectors.messageNode));
    }

    /**
     * 查找当前右侧消息区的可滚动容器，用于向上翻到顶部拉取历史消息。
     * @returns {HTMLElement | null} 消息滚动容器。
     */
    function findConversationHistoryScroller() {
        const messageNode = getRenderedMessageNodes()[0];
        if (!messageNode) {
            return null;
        }

        let current = messageNode.parentElement;
        while (current && current !== document.body) {
            const style = window.getComputedStyle(current);
            const canScroll = current.scrollHeight > current.clientHeight + 20;
            const overflowY = style.overflowY || '';
            if (canScroll && /(auto|scroll)/i.test(overflowY || '')) {
                return current;
            }
            if (canScroll && current.scrollTop > 0) {
                return current;
            }
            current = current.parentElement;
        }

        return null;
    }

    /**
     * 将当前会话的消息区翻到顶部，尽量把历史消息完整拉回 DOM。
     * 该过程只用于启动初始化和必要的补水，不作为常驻巡逻逻辑。
     * @returns {Promise<void>}
     */
    async function loadFullConversationHistory() {
        const scroller = findConversationHistoryScroller();
        if (!scroller) {
            return;
        }

        let lastMessageCount = getRenderedMessageNodes().length;
        let stableRounds = 0;
        const deadline = Date.now() + CONFIG.historyLoadMaxDurationMs;

        for (let step = 0; step < CONFIG.historyLoadMaxScrolls && Date.now() < deadline; step++) {
            const beforeTop = scroller.scrollTop;
            const beforeHeight = scroller.scrollHeight;
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await sleep(CONFIG.historyLoadStepDelayMs);

            const nextMessageCount = getRenderedMessageNodes().length;
            const nextHeight = scroller.scrollHeight;
            const madeProgress =
                beforeTop > 5
                || nextMessageCount > lastMessageCount
                || nextHeight > beforeHeight;

            if (!madeProgress && scroller.scrollTop <= 5) {
                stableRounds += 1;
            } else {
                stableRounds = 0;
            }

            lastMessageCount = Math.max(lastMessageCount, nextMessageCount);
            if (stableRounds >= 2) {
                break;
            }
        }

        scroller.scrollTop = scroller.scrollHeight;
        await sleep(150);
    }

    /**
     * 打开指定左侧会话项，并执行一次提取；可选地先补拉该会话的全部历史。
     * @param {HTMLElement} itemEl - 左侧会话项节点。
     * @param {{ expectedCustomerName?: string | null, pullFullHistory?: boolean }} options - 会话采集选项。
     * @returns {Promise<boolean>} 是否成功完成本次采集。
     */
    async function captureConversationFromListItem(itemEl, options = {}) {
        const {
            expectedCustomerName = null,
            pullFullHistory = false
        } = options;

        if (!itemEl || !itemEl.isConnected) {
            return false;
        }

        itemEl.click();
        if (itemEl.firstElementChild) {
            itemEl.firstElementChild.click();
        }

        const rendered = await waitForConversationRender(expectedCustomerName);
        if (!rendered) {
            return false;
        }

        await sleep(CONFIG.initialConversationClickDelayMs);
        if (pullFullHistory) {
            await loadFullConversationHistory();
        }
        await extractData(expectedCustomerName ? { customerName: expectedCustomerName } : null);
        return true;
    }

    /**
     * 判断左侧会话项是否带有闲鱼未读角标。
     * @param {HTMLElement} itemEl - 左侧会话项节点。
     * @returns {HTMLElement | null} 未读角标元素；未命中则返回 null。
     */
    function getUnreadBadgeElement(itemEl) {
        return itemEl.querySelector('sup.ant-scroll-number.ant-badge-count')
            || itemEl.querySelector('sup.ant-badge-count')
            || itemEl.querySelector('[class*="ant-badge-count"]');
    }

    /**
     * 从当前可见列表中提取带未读角标的会话，供增量同步使用。
     * @returns {{ itemEl: HTMLElement, title: string, visitKey: string, unreadKey: string }[]} 当前可见未读会话。
     */
    function buildVisibleUnreadEntries() {
        const unreadEntries = [];
        const occurrenceMap = new Map();

        for (const itemEl of getSidebarItems()) {
            if (!getUnreadBadgeElement(itemEl)) {
                continue;
            }

            const meta = getItemIdentifier(itemEl, occurrenceMap);
            const sessionInfo = extractSessionInfoFromConversationItem(itemEl);
            unreadEntries.push({
                itemEl,
                title: meta.title,
                visitKey: meta.visitKey,
                unreadKey: sessionInfo?.sessionId || meta.visitKey
            });
        }

        return unreadEntries;
    }

    /**
     * 项目启动时做一轮限量初始化，把前 N 个会话的历史记录尽快拉回本地缓存与数据库。
     * 初始化完成后自动关闭常驻巡逻，但保留遍历能力作为精准发送 fallback。
     * @returns {Promise<void>}
     */
    async function runInitialConversationSync(syncNonce, sessionCount) {
        if (state.initializationBusy) {
            return;
        }
        if (!syncNonce) {
            return;
        }
        if (syncNonce === state.lastHandledInitialCrawlNonce || syncNonce === state.activeInitialCrawlNonce) {
            return;
        }

        const limit = sessionCount || CONFIG.initialConversationSyncLimit;

        const workspaceReady = await waitForChatWorkspaceReady();
        if (!workspaceReady) {
            state.statusText = '初始化跳过：聊天工作区未在预期时间内加载完成';
            renderFooter();
            return;
        }

        state.initializationBusy = true;
        state.activeInitialCrawlNonce = syncNonce;
        setCrawlingEnabled(false, 'startup-init', { transient: true });
        state.statusText = `初始化同步中（最多 ${limit} 个会话）...`;
        renderFooter();

        const visited = new Set();
        let processed = 0;

        try {
            const container = getSidebarContainer();
            if (!container) {
                return;
            }

            container.scrollTop = 0;
            await sleep(300);
            await sleep(CONFIG.startupPostReadyDelayMs);

            while (processed < limit) {
                if (isUserTypingMessage() || state.senderBusy) {
                    await sleep(800);
                    continue;
                }

                const items = getSidebarItems();
                if (!items.length) {
                    break;
                }

                let targetItem = null;
                let targetMeta = null;
                const occurrenceMap = new Map();
                for (const item of items) {
                    const meta = getItemIdentifier(item, occurrenceMap);
                    if (!visited.has(meta.visitKey)) {
                        targetItem = item;
                        targetMeta = meta;
                        break;
                    }
                }

                if (targetItem && targetMeta) {
                    visited.add(targetMeta.visitKey);
                    processed += 1;
                    state.statusText = `初始化同步 ${processed}/${limit}: ${targetMeta.title}`;
                    renderFooter();
                    await captureConversationFromListItem(targetItem, {
                        expectedCustomerName: targetMeta.title,
                        pullFullHistory: true
                    });
                    await sleep(CONFIG.initialConversationBetweenDelayMs);
                    continue;
                }

                const maxScrollTop = container.scrollHeight - container.clientHeight;
                if (container.scrollTop >= maxScrollTop - 5) {
                    break;
                }

                container.scrollTop += container.clientHeight;
                await sleep(500);
            }
        } catch (error) {
            console.error('[XM] initial conversation sync failed:', error.message || error);
        } finally {
            state.initializationBusy = false;
            state.initializationCompleted = true;
            state.lastHandledInitialCrawlNonce = syncNonce;
            state.activeInitialCrawlNonce = null;
            setCrawlingEnabled(false, 'startup-init-finish');
            setCrawlingEnabled(true, 'startup-init', { transient: true });
            await persistCrawlerDesiredState(false);
            state.statusText = `初始化完成：已同步 ${processed} 个会话，自动巡逻已关闭`;
            renderFooter();
        }
    }

    /**
     * 关闭自动巡逻后，仅根据左侧未读角标做增量抓取。
     * 这不会重跑全量遍历，只处理有未读提示的会话。
     * @returns {Promise<void>}
     */
    async function runUnreadWatchOnce() {
        if (state.unreadWatchBusy || state.initializationBusy || state.senderBusy || state.isCrawling) {
            return;
        }
        if (isUserTypingMessage()) {
            return;
        }

        const unreadEntries = buildVisibleUnreadEntries();
        const candidate = unreadEntries.find((entry) => {
            const lastHandledAt = state.unreadHandledAt[entry.unreadKey] || 0;
            return Date.now() - lastHandledAt >= CONFIG.unreadHandleCooldownMs;
        });

        if (!candidate) {
            return;
        }

        state.unreadWatchBusy = true;
        try {
            state.statusText = `未读同步: ${candidate.title}`;
            renderFooter();
            state.unreadHandledAt[candidate.unreadKey] = Date.now();
            await captureConversationFromListItem(candidate.itemEl, {
                expectedCustomerName: candidate.title,
                pullFullHistory: false
            });
        } catch (error) {
            console.warn('[XM] unread watch failed:', error.message || error);
        } finally {
            state.unreadWatchBusy = false;
        }
    }

    /**
     * 启动未读会话监听循环。
     * 初始化完成后，自动巡逻关闭，但这条循环会持续根据未读角标同步新消息。
     */
    function startUnreadWatchLoop() {
        startSerialLoop(runUnreadWatchOnce, CONFIG.unreadWatchIntervalMs);
    }

    /**
     * 按“当前可见项中第一个未访问会话”的策略驱动左侧列表巡逻。
     */
    function crawlNext() {
        if (!state.isCrawling) return;
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true')) {
            state.statusText = '检测到输入，暂停...'; renderFooter(); setTimeout(crawlNext, 2000); return;
        }

        // Limit Check & Reset
        if (state.crawledTotal >= CONFIG.maxCrawlLimit) {
            state.statusText = `已抓取 ${state.crawledTotal} 次，重置...`;
            renderFooter();
            state.crawledTotal = 0;
            state.visitedThisCycle.clear();
            state.noNewItemsStreak = 0;
            const container = getSidebarContainer();
            if (container) container.scrollTop = 0;
            setTimeout(crawlNext, 3000);
            return;
        }

        const items = getSidebarItems();
        if (items.length === 0) {
            state.statusText = '未找到列表'; renderFooter(); setTimeout(crawlNext, 2000); return;
        }

        buildVisibleConversationEntries();

        // 找当前可见项中第一个未访问的
        let targetItem = null;
        let targetMeta = null;
        const occurrenceMap = new Map();
        for (const item of items) {
            const meta = getItemIdentifier(item, occurrenceMap);
            if (meta.visitKey && !state.visitedThisCycle.has(meta.visitKey)) {
                targetItem = item;
                targetMeta = meta;
                break;
            }
        }

        if (targetItem) {
            // 找到未访问的会话
            state.noNewItemsStreak = 0;
            state.visitedThisCycle.add(targetMeta.visitKey);
            state.crawledTotal++;
            state.statusText = `抓取: ${state.crawledTotal} (本轮已访 ${state.visitedThisCycle.size})`; renderFooter();

            targetItem.click();
            if (targetItem.firstElementChild) targetItem.firstElementChild.click();

            const delay = Math.floor(Math.random() * (CONFIG.maxDelay - CONFIG.minDelay + 1)) + CONFIG.minDelay;
            const expectedSession = {
                customerName: targetMeta.title,
                visitKey: targetMeta.visitKey
            };

            setTimeout(async () => {
                await extractData(expectedSession);
                crawlNext();
            }, delay);
        } else {
            // 当前可见项全部已访问，需要翻页或开始新一轮
            const container = getSidebarContainer();
            if (!container) { setTimeout(crawlNext, 2000); return; }

            const currentScroll = container.scrollTop;
            const maxScroll = container.scrollHeight - container.clientHeight;

            if (currentScroll >= maxScroll - 5) {
                // 已到底部，本轮完成
                state.statusText = `本轮完成 (共 ${state.visitedThisCycle.size} 个会话)，重新开始...`;
                renderFooter();
                state.visitedThisCycle.clear();
                state.noNewItemsStreak = 0;
                container.scrollTop = 0;
                setTimeout(crawlNext, 3000);
            } else {
                // 翻页
                state.noNewItemsStreak++;
                if (state.noNewItemsStreak > 20) {
                    state.statusText = '长期无新会话，重置本轮...'; renderFooter();
                    state.visitedThisCycle.clear();
                    state.noNewItemsStreak = 0;
                    container.scrollTop = 0;
                    setTimeout(crawlNext, 3000);
                    return;
                }
                state.statusText = '翻页中...'; renderFooter();
                container.scrollTop += container.clientHeight;
                setTimeout(crawlNext, 2000);
            }
        }
    }

    // --- Core Extraction ---
    /**
     * 提取当前右侧会话详情，并在必要时将其写入本地缓存与后端。
     * @param {{ customerName?: string, visitKey?: string } | null} expectedSession - 左侧点击时记录的预期会话信息。
     */
    async function extractData(expectedSession) {
        try {
            const main = document.querySelector('div[role="main"]') || document.querySelector('main');
            if (!main) return;
            let dataChanged = false;
            const visibleEntries = buildVisibleConversationEntries();
            const activeEntry = visibleEntries.find(entry => entry.isActive) || null;

            let customerName = 'Unknown';
            const headerEl = main.querySelector('div');
            if (headerEl) {
                const nameCandidate = headerEl.innerText.split('\n')[0];
                if (nameCandidate && !nameCandidate.includes(CONFIG.userName) && nameCandidate !== '消息') {
                    customerName = nameCandidate.trim();
                }
            }
            if (customerName === 'Unknown' || customerName === '尚未选择任何联系人' || customerName === '通知消息') return;

            // CRUCIAL: Verify that React has finished rendering the new chat window by comparing names
            if (expectedSession?.customerName && customerName !== expectedSession.customerName) {
                console.warn(`[XM] React render lag detected! Left panel: ${expectedSession.customerName}, Right: ${customerName}. Skipping extraction.`);
                return;
            }

            let product = {};
            const productLink = main.querySelector('a[href*="/item?id="]');
            if (productLink) {
                const container = productLink.closest('div');
                const text = container ? container.innerText : '';
                const priceMatch = text.match(/¥\d+(\.\d+)?/);
                product = {
                    price: priceMatch ? priceMatch[0] : '',
                    location: text.includes('·') ? text.split('\n').find(l => l.includes('·')) : '',
                    url: productLink.href,
                    id: productLink.href.match(/id=(\d+)/) ? productLink.href.match(/id=(\d+)/)[1] : null,
                    userId: null
                };
            }

            // 提取买家 userId：右上角“闲鱼号”按钮所在容器 .right-container--AxSGn7lz 内的 a[href*="userId="]
            try {
                const rightBox = main.querySelector('.right-container--AxSGn7lz');
                const userLink = rightBox ? rightBox.querySelector('a[href*="userId="]') : null;
                if (userLink && userLink.href) {
                    const m = userLink.href.match(/userId=([^&#]+)/);
                    if (m) {
                        const uid = decodeURIComponent(m[1]);
                        if (!product.userId) product.userId = uid;
                    }
                }
            } catch (e) {
                console.warn('[XM] extract userId failed', e);
            }

            if (!product.price) {
                const divs = Array.from(main.querySelectorAll('div'));
                const priceDiv = divs.find(d => d.innerText.includes('¥') && d.innerText.length < 50 && (d.innerText.includes('含运费') || d.innerText.includes('立即购买')));
                if (priceDiv) {
                    const priceMatch = priceDiv.innerText.match(/¥\d+(\.\d+)?/);
                    product.price = priceMatch ? priceMatch[0] : '';
                    product.location = priceDiv.innerText.split('\n').find(l => l.includes('·')) || '';
                }
            }

            const messages = [];
            const messageNodes = getRenderedMessageNodes(main);

            messageNodes.forEach(el => {
                const imgContainer = el.querySelector(CONFIG.selectors.imageContainer);
                if (imgContainer) {
                    // 图片消息：优先取 ant-image-img（原图URL），其次取容器内第一个 img
                    const origImg = imgContainer.querySelector('.ant-image-img');
                    const fallbackImg = imgContainer.querySelector('img');
                    const imgSrc = (origImg && origImg.src) || (fallbackImg && fallbackImg.src) || '';
                    if (!imgSrc) return;
                    // 方向判断：检查 flex 列容器的 align-items
                    const flexCol = el.querySelector('div[style*="flex-direction: column"]');
                    const isMe = flexCol ? flexCol.style.alignItems === 'flex-end' : false;
                    messages.push({ content: imgSrc, isMe, type: 'image' });
                    return;
                }
                const textNode = el.querySelector('[class*="message-text--"]');
                if (textNode) {
                    const content = textNode.innerText.trim();
                    if (!content) return;
                    const isMe = textNode.className.includes('message-text-right');
                    messages.push({ content, isMe, type: 'text' });
                }
            });

            const canonicalChatKey = findCanonicalChatKey(customerName, messages);
            const chatKey = product.id
                ? buildChatKey(customerName, product.id)
                : (canonicalChatKey || buildChatKey(customerName, null));
            const buyerUserId = activeEntry?.sessionInfo?.userInfo?.userId || product.userId || null;
            state.currentKey = chatKey;
            state.currentSessionId = activeEntry?.sessionId || null;
            state.currentSessionInfo = activeEntry?.sessionInfo || null;

            const incomingChat = {
                customerName,
                productId: product.id || null,
                buyerUserId,
                product,
                messages,
                sessionId: activeEntry?.sessionId || null,
                sessionInfo: activeEntry?.sessionInfo || null
            };

            const anonymousChatKey = buildChatKey(customerName, null);
            if (product.id && anonymousChatKey !== chatKey && state.chats[anonymousChatKey] && areMessagesEquivalent(state.chats[anonymousChatKey].messages || [], messages)) {
                if (mergeDuplicateChatState(anonymousChatKey, chatKey, incomingChat)) {
                    console.info(`[XM] merged anonymous duplicate chat ${anonymousChatKey} -> ${chatKey}`);
                    dataChanged = true;
                }
            }

            if (syncChatState(chatKey, incomingChat)) {
                dataChanged = true;
            }

            if (dataChanged) {
                scheduleStateSave();
                schedulePanelRender();
            }

        } catch (e) { console.error('[XM]', e); }
    }

    /**
     * 判断当前是否存在可供轻量同步的活跃会话，避免在空白页上空转。
     * @returns {boolean} 当前是否检测到活跃会话。
     */
    function hasActiveConversation() {
        if (getCurrentActiveSessionId()) {
            return true;
        }

        const main = document.querySelector('div[role="main"]') || document.querySelector('main');
        if (!main) {
            return false;
        }

        const mainText = (main.innerText || '').trim();
        return !!mainText && !/尚未选择任何联系人|通知消息/u.test(mainText);
    }

    /**
     * 在关闭巡逻时继续同步当前打开会话，避免消息记录只能依赖遍历补拉。
     * 该逻辑不会切换会话，只会读取当前右侧聊天窗口。
     * @returns {Promise<void>}
     */
    async function runActiveConversationSyncOnce() {
        if (state.activeSyncBusy || state.senderBusy || state.initializationBusy || state.unreadWatchBusy) {
            return;
        }
        if (!hasActiveConversation()) {
            return;
        }

        state.activeSyncBusy = true;
        try {
            await extractData(null);
        } catch (error) {
            console.warn('[XM] active conversation sync failed:', error.message || error);
        } finally {
            state.activeSyncBusy = false;
        }
    }

    /**
     * 启动当前会话轻量同步循环。
     * 关闭巡逻后，这条循环继续工作，用来持续同步当前打开会话的消息变化。
     */
    function startActiveConversationSyncLoop() {
        runActiveConversationSyncOnce();
        startSerialLoop(runActiveConversationSyncOnce, CONFIG.activeSyncIntervalMs, { immediate: false });
    }

    /**
     * 查找当前聊天窗口的输入框元素。
     * @returns {HTMLTextAreaElement | HTMLElement | null} 可输入的消息框。
     */
    function findMessageInputElement() {
        const inputSelectors = [
            'textarea[class*="input"]',
            'div[contenteditable="true"]',
            'textarea[placeholder*="输入"]',
            'textarea[placeholder*="消息"]',
            '.chat-input textarea',
            '#message-input',
            'textarea',
        ];

        for (const selector of inputSelectors) {
            const inputEl = document.querySelector(selector);
            if (inputEl) {
                return inputEl;
            }
        }
        return null;
    }

    /**
     * 判断当前可见会话项是否匹配待发任务。
     * @param {{ sessionId: string, title: string, productId: string }} entry - 当前可见会话项。
     * @param {{ chat_key?: string, session_id?: string, customer_name?: string, product_id?: string }} task - 待发任务。
     * @returns {boolean} 是否命中该会话。
     */
    function doesConversationMatchTask(entry, task) {
        const cachedChat = task.chat_key ? state.chats[task.chat_key] : null;
        const taskSessionId = task.session_id || cachedChat?.sessionId || '';
        const taskProductId = String(task.product_id || cachedChat?.productId || '').trim();
        const taskCustomerName = task.customer_name || cachedChat?.customerName || (task.chat_key || '').split('_')[0];

        if (taskSessionId && entry.sessionId === String(taskSessionId)) {
            return true;
        }
        if (taskProductId) {
            return entry.title === taskCustomerName && entry.productId === taskProductId;
        }
        return !!taskCustomerName && entry.title === taskCustomerName;
    }

    /**
     * 等待指定 session_id 成为当前激活会话。
     * @param {string|null} targetSessionId - 目标会话 ID。
     * @returns {Promise<boolean>} 是否在超时前成功激活。
     */
    async function waitForSessionActivation(targetSessionId) {
        const deadline = Date.now() + CONFIG.targetOpenTimeoutMs;
        while (Date.now() < deadline) {
            const activeSessionId = getCurrentActiveSessionId();
            if (!targetSessionId || (activeSessionId && String(activeSessionId) === String(targetSessionId))) {
                return true;
            }
            await sleep(250);
        }
        return false;
    }

    /**
     * 打开指定会话项，并等待它成为当前激活会话。
     * @param {{ itemEl: HTMLElement, sessionId: string }} entry - 目标会话项。
     * @returns {Promise<boolean>} 是否成功打开。
     */
    async function activateConversationEntry(entry) {
        if (!entry?.itemEl || !entry.itemEl.isConnected) {
            return false;
        }
        entry.itemEl.click();
        if (entry.itemEl.firstElementChild) {
            entry.itemEl.firstElementChild.click();
        }
        return waitForSessionActivation(entry.sessionId || null);
    }

    /**
     * 在当前可见会话列表中直接命中目标任务。
     * @param {{ chat_key?: string, session_id?: string, customer_name?: string, product_id?: string }} task - 待发任务。
     * @returns {{ itemEl: HTMLElement, sessionId: string, sessionInfo: Record<string, any>, title: string, productId: string, isActive: boolean } | null} 命中的可见会话项。
     */
    function findVisibleConversationForTask(task) {
        const visibleEntries = buildVisibleConversationEntries();
        return visibleEntries.find(entry => doesConversationMatchTask(entry, task)) || null;
    }

    /**
     * 在后台巡逻之外执行一次限次补水，尝试把目标会话滚动到可见区域。
     * @param {{ chat_key?: string, session_id?: string, customer_name?: string, product_id?: string }} task - 待发任务。
     * @returns {Promise<any | null>} 命中的会话项；失败时返回 null。
     */
    async function locateConversationWithFallback(task) {
        const directVisibleMatch = findVisibleConversationForTask(task);
        if (directVisibleMatch) {
            return directVisibleMatch;
        }

        const container = getSidebarContainer();
        if (!container) {
            return null;
        }

        const startedAt = Date.now();
        container.scrollTop = 0;
        await sleep(200);

        for (let step = 0; step < CONFIG.targetLocateMaxScrolls; step++) {
            const visibleMatch = findVisibleConversationForTask(task);
            if (visibleMatch) {
                return visibleMatch;
            }

            if (Date.now() - startedAt >= CONFIG.targetLocateMaxDurationMs) {
                break;
            }

            const maxScrollTop = container.scrollHeight - container.clientHeight;
            if (container.scrollTop >= maxScrollTop - 5) {
                break;
            }

            container.scrollTop += container.clientHeight;
            await sleep(CONFIG.targetLocateStepDelayMs);
        }

        return findVisibleConversationForTask(task);
    }

    /**
     * 通过 claim 接口原子领取一条待发消息。
     * @returns {Promise<any | null>} 当前领取到的任务；没有任务时返回 null。
     */
    async function claimOutgoingMessageTask() {
        const payload = await browserApiRequest('outgoing.claim', {});
        return payload?.message || null;
    }

    /**
     * 回写待发消息状态。
     * @param {number} id - 待发消息主键。
     * @param {'sent' | 'failed'} status - 回写状态。
     * @param {string|null} error - 失败原因。
     * @returns {Promise<void>}
     */
    async function patchOutgoingMessageStatus(id, status, error = null) {
        await browserApiRequest('outgoing.patch', {
            id,
            status,
            error
        });
    }

    /**
     * 将文本写入输入框并点击发送按钮。
     * @param {string} content - 待发送内容。
     * @returns {Promise<void>}
     */
    async function sendMessageContent(content) {
        const inputEl = findMessageInputElement();
        if (!inputEl) {
            throw new Error('找不到输入框');
        }

        inputEl.focus();

        const textareaSetter = window.HTMLTextAreaElement?.prototype
            ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
            : null;
        if (textareaSetter && inputEl instanceof HTMLTextAreaElement) {
            textareaSetter.call(inputEl, content);
        } else if ('value' in inputEl) {
            inputEl.value = content;
        } else {
            inputEl.textContent = content;
        }
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));

        await sleep(500);

        const sendBtn = findSendButtonElement();
        if (!sendBtn) {
            throw new Error('找不到发送按钮');
        }

        sendBtn.click();
        await sleep(1000);

        if (textareaSetter && inputEl instanceof HTMLTextAreaElement) {
            textareaSetter.call(inputEl, '');
        } else if ('value' in inputEl) {
            inputEl.value = '';
        } else {
            inputEl.textContent = '';
        }
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.blur();
    }

    /**
     * 在发送动作完成后重新抓取当前会话，确保新发出的消息能及时写回本地缓存并被 sync.js 上报。
     * @returns {Promise<void>}
     */
    async function syncConversationAfterSend() {
        await sleep(1200);
        await extractData(null);
    }

    /**
     * 为当前待发任务定位目标会话并切换到该会话。
     * @param {{ id: number, chat_key?: string, session_id?: string, customer_name?: string, product_id?: string }} task - 待发任务。
     * @returns {Promise<boolean>} 是否成功定位并激活目标会话。
     */
    async function prepareConversationForTask(task) {
        const currentActiveSessionId = getCurrentActiveSessionId();
        if (task.session_id && currentActiveSessionId && String(currentActiveSessionId) === String(task.session_id)) {
            await extractData(null);
            return true;
        }

        const targetEntry = await locateConversationWithFallback(task);
        if (!targetEntry) {
            return false;
        }

        const activated = await activateConversationEntry(targetEntry);
        if (!activated) {
            return false;
        }

        await sleep(500);
        await extractData(null);
        return true;
    }

    /**
     * 执行一次精准发送轮询，优先 claim 任务并主动定位目标会话。
     * @returns {Promise<void>}
     */
    async function runSenderOnce() {
        if (state.senderBusy) return;
        state.senderBusy = true;

        let claimedTask = null;
        try {
            claimedTask = await claimOutgoingMessageTask();
            if (!claimedTask) {
                return;
            }

            const cachedChat = claimedTask.chat_key ? state.chats[claimedTask.chat_key] : null;
            if (!claimedTask.session_id && cachedChat?.sessionId) {
                claimedTask.session_id = cachedChat.sessionId;
            }

            state.statusText = `精准发送 #${claimedTask.id}...`;
            renderFooter();
            setCrawlingEnabled(false, 'sender-loop', { transient: true });

            const located = await prepareConversationForTask(claimedTask);
            if (!located) {
                throw new Error('未找到目标会话');
            }

            await sendMessageContent(claimedTask.content || '');
            await syncConversationAfterSend();
            await patchOutgoingMessageStatus(claimedTask.id, 'sent');
            state.statusText = `消息 #${claimedTask.id} 已发送`;
            renderFooter();
        } catch (error) {
            console.error('[XM Sender] runSenderOnce failed:', error.message || error);
            if (claimedTask?.id) {
                try {
                    await patchOutgoingMessageStatus(claimedTask.id, 'failed', error.message || '发送失败');
                } catch (patchError) {
                    console.error('[XM Sender] fail patch failed:', patchError.message || patchError);
                }
            }
            state.statusText = `精准发送失败: ${error.message || error}`;
            renderFooter();
        } finally {
            setCrawlingEnabled(true, 'sender-loop', { transient: true });
            state.senderBusy = false;
        }
    }

    /**
     * 启动精准发送轮询，不依赖后台巡逻开关。
     */
    function startSenderLoop() {
        const loop = async () => {
            await runSenderOnce();
            setTimeout(loop, CONFIG.senderPollIntervalMs);
        };
        loop();
    }

    /**
     * 以串行方式启动一个浏览器端轮询循环，保证上一次执行结束后才会安排下一次，避免多个定时任务排队挤爆主线程。
     * @param {() => Promise<void> | void} runner - 单次轮询执行函数。
     * @param {number} intervalMs - 两次执行之间的等待间隔。
     * @param {{ immediate?: boolean }} options - 是否立即先执行一次。
     */
    function startSerialLoop(runner, intervalMs, options = {}) {
        const { immediate = true } = options;

        const tick = async () => {
            try {
                await runner();
            } catch (error) {
                console.warn('[XM] serial loop failed:', error.message || error);
            } finally {
                window.setTimeout(tick, intervalMs);
            }
        };

        window.setTimeout(tick, immediate ? 0 : intervalMs);
    }

    /**
     * 向后端上报当前巡逻状态，并把 3210 期望的巡逻开关同步回本地脚本。
     * @returns {Promise<void>}
     */
    async function syncCrawlerHeartbeat() {
        try {
            const payload = await browserApiRequest('browser.heartbeat', {
                crawlerEnabled: state.crawlingDesiredEnabled,
                currentChatKey: state.currentKey,
                currentSessionId: state.currentSessionId,
                initialCrawlNonceHandled: state.lastHandledInitialCrawlNonce
            });
            if (typeof payload.crawlerDesiredEnabled === 'boolean'
                && payload.crawlerDesiredEnabled !== state.crawlingDesiredEnabled) {
                setCrawlingEnabled(payload.crawlerDesiredEnabled, 'remote-sync');
            }
            // 检查是否有新的初始遍历请求
            if (payload.initialCrawlNonce
                && payload.initialCrawlNonce !== state.lastHandledInitialCrawlNonce
                && payload.initialCrawlNonce !== state.activeInitialCrawlNonce
                && !state.initializationBusy) {
                runInitialConversationSync(payload.initialCrawlNonce, payload.initialCrawlSessionCount);
            }
        } catch (error) {
            console.warn('[XM] heartbeat failed:', error.message || error);
        }
    }

    /**
     * 启动浏览器脚本心跳与远程巡逻开关同步。
     */
    function startHeartbeatLoop() {
        syncCrawlerHeartbeat();
        startSerialLoop(syncCrawlerHeartbeat, CONFIG.heartbeatIntervalMs, { immediate: false });
    }

    /**
     * 定时检测闲鱼IM页面的"连接中断，请重连"弹窗，检测到后自动刷新页面。
     */
    function startDisconnectDialogWatcher() {
        setInterval(() => {
            const modal = document.querySelector('.ant-modal');
            if (!modal) return;
            const title = modal.querySelector('.ant-modal-title');
            if (title && title.textContent.includes('连接中断')) {
                console.warn('[XM] 检测到连接中断弹窗，自动刷新页面');
                location.reload();
            }
        }, 5000);
    }

    function init() {
        console.log('[XM] Starting...');

        // 自动从页面 header 提取当前用户昵称
        if (!CONFIG.userName) {
            const nickEl = document.querySelector('a[href*="/personal"] .nick--RyNYtDXM, a[href*="/personal"] div[class*="nick--"]');
            if (nickEl) {
                CONFIG.userName = nickEl.textContent.trim();
                console.log(`[XM] Auto-detected userName: ${CONFIG.userName}`);
            } else {
                console.warn('[XM] Failed to auto-detect userName from header, customerName extraction may be inaccurate.');
            }
        }

        connectBrowserApiSocket().catch((error) => {
            console.warn('[XM] browser api socket init failed:', error.message || error);
        });
        const cleanedCount = cleanupAnonymousDuplicateChats();
        if (cleanedCount > 0) {
            console.info(`[XM] cleaned ${cleanedCount} anonymous duplicate chat(s).`);
            saveState();
        }
        createPanel();
        renderPanel();
        startHeartbeatLoop();
        startSenderLoop();
        startActiveConversationSyncLoop();
        startUnreadWatchLoop();
        startDisconnectDialogWatcher();
    }

    window.addEventListener('beforeunload', closeBrowserApiSocket);

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();
