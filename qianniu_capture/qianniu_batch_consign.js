// ==UserScript==
// @name         千牛待发货订单采集 (v1.5)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  采集千牛待发货订单并同步到本地 goofishAggregation 控制台，支持买家信息解密与商品 ID 补全
// @author       Codex
// @match        https://myseller.taobao.com/home.htm/batch-consign*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      trade.taobao.com
// ==/UserScript==
// @ts-nocheck
(function () {
    'use strict';
    const SCRIPT_VERSION = '1.5';
    const CONFIG = {
        apiWebSocketUrl: 'wss://127.0.0.1:3211/ws/browser',
        apiRequestTimeoutMs: 10000,
        apiReconnectDelayMs: 1500,
        heartbeatIntervalMs: 3000,
        syncIntervalMs: 5000,
        pageReadyTimeoutMs: 20000,
        syncDebounceMs: 300,
        pageChangeTimeoutMs: 10000,
        panelId: 'goofish-qianniu-sync-panel',
        orderListContainerSelector: '.sc-dAlyuH.gQtCjr',
        orderCardSelector: '.list-item-wrapper',
        orderCacheStorageKey: 'goofish_qianniu_order_enrichment_v1',
        decryptWaitTimeoutMs: 8000,
        decryptPollIntervalMs: 250,
        decryptRetryCooldownMs: 60000,
        detailRequestTimeoutMs: 10000,
        detailRetryCooldownMs: 300000,
        pendingSyncNonceStorageKey: 'goofish_qianniu_pending_sync_nonce',
    };
    const state = {
        online: false,
        visibleOrderCount: 0,
        lastSyncAt: 0,
        lastSyncResult: null,
        syncBusy: false,
        syncTimer: null,
        scanState: 'idle',
        activeSyncNowNonce: null,
        lastHandledSyncNowNonce: null,
        activeScanNonce: null,
        lastHandledScanNonce: null,
        lastScanSummary: null,
    };
    const browserApiState = {
        socket: null,
        connectPromise: null,
        reconnectTimer: null,
        nextRequestId: 0,
        pendingRequests: new Map(),
        manualClose: false,
    };
    const enrichmentState = {
        cache: loadPersistedOrderEnrichmentCache(),
        persistTimer: null,
        decryptRequests: new Map(),
        productIdRequests: new Map(),
    };
    /**
     * 从 localStorage 恢复订单增强缓存，避免同一订单重复点“解密”或重复抓取详情页。
     * @returns {Record<string, Record<string, any>>} 以 orderId 为键的缓存映射。
     */
    function loadPersistedOrderEnrichmentCache() {
        try {
            const raw = window.localStorage.getItem(CONFIG.orderCacheStorageKey);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch (_) {
            return {};
        }
    }
    /**
     * 将订单增强缓存延迟写回 localStorage，避免高频同步时每次都落盘。
     */
    function schedulePersistOrderEnrichmentCache() {
        if (enrichmentState.persistTimer) {
            window.clearTimeout(enrichmentState.persistTimer);
        }
        enrichmentState.persistTimer = window.setTimeout(() => {
            enrichmentState.persistTimer = null;
            try {
                window.localStorage.setItem(CONFIG.orderCacheStorageKey, JSON.stringify(enrichmentState.cache));
            }
            catch (error) {
                console.warn('[QN] persist order enrichment cache failed:', error.message || error);
            }
        }, 120);
    }
    /**
     * 读取单个订单的增强缓存。
     * @param {string | null} orderId - 订单编号。
     * @returns {Record<string, any>} 订单缓存快照。
     */
    function readOrderEnrichmentCache(orderId) {
        if (!orderId) {
            return {};
        }
        const cached = enrichmentState.cache[orderId];
        return cached && typeof cached === 'object' ? cached : {};
    }
    /**
     * 合并并保存单个订单的增强缓存。
     * @param {string | null} orderId - 订单编号。
     * @param {Record<string, any>} patch - 待合并的字段。
     * @returns {Record<string, any>} 合并后的缓存快照。
     */
    function patchOrderEnrichmentCache(orderId, patch = {}) {
        if (!orderId) {
            return {};
        }
        const nextValue = {
            ...readOrderEnrichmentCache(orderId),
            ...patch,
        };
        enrichmentState.cache[orderId] = nextValue;
        schedulePersistOrderEnrichmentCache();
        return nextValue;
    }
    /**
     * 提供统一延时，供同步与翻页等待复用。
     * @param {number} ms - 延迟毫秒数。
     * @returns {Promise<void>} 延时 Promise。
     */
    function sleep(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }
    /**
     * 对可选文本做去空白归一化，空值统一转成空串。
     * @param {any} value - 原始字段值。
     * @returns {string} 归一化后的文本。
     */
    function normalizeText(value) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    }
    /**
     * 归一化商品 ID，仅接受看起来像淘宝商品编号的纯数字文本。
     * 会主动排除与订单号相同的值，避免把 tradeId / orderId 误判成商品 ID。
     * @param {any} value - 原始候选值。
     * @param {string | null} orderId - 当前订单号。
     * @returns {string | null} 归一化后的商品 ID。
     */
    function normalizeProductId(value, orderId = null) {
        const normalized = normalizeText(value);
        if (!/^\d{6,20}$/.test(normalized)) {
            return null;
        }
        if (orderId && normalized === normalizeText(orderId)) {
            return null;
        }
        return normalized;
    }
    /**
     * 归一化商品金额，统一输出为带人民币符号的文本。
     * @param {any} value - 原始金额文本。
     * @returns {string | null} 归一化后的金额。
     */
    function normalizePriceText(value) {
        const normalized = normalizeText(value);
        const match = normalized.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
        return match ? `￥${match[1]}` : null;
    }
    /**
     * 归一化购买数量，统一输出为正整数文本。
     * @param {any} value - 原始数量值。
     * @returns {string | null} 数量文本。
     */
    function normalizeQuantityText(value) {
        const normalized = normalizeText(value);
        const match = normalized.match(/(\d+)/);
        if (!match) {
            return null;
        }
        const quantity = Number(match[1]);
        return Number.isInteger(quantity) && quantity > 0 ? String(quantity) : null;
    }
    /**
     * 将时间戳格式化为本地可读时间文案。
     * @param {number} ts - Unix 秒级时间戳。
     * @returns {string} 人类可读时间文案。
     */
    function formatDateTime(ts) {
        if (!ts)
            return '未同步';
        return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
    }
    /**
     * 判断元素是否在当前页面中可见，避免采到隐藏模板节点。
     * @param {Element | null} el - 待检测元素。
     * @returns {boolean} 是否可见。
     */
    function isElementVisible(el) {
        if (!el)
            return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0';
    }
    /**
     * 拒绝当前所有挂起的 WSS RPC 请求，避免连接断开后 Promise 悬挂。
     * @param {string} reason - 批量失败原因。
     */
    function rejectPendingBrowserApiRequests(reason) {
        for (const [, pending] of browserApiState.pendingRequests.entries()) {
            window.clearTimeout(pending.timerId);
            pending.reject(new Error(reason || 'browser api request failed'));
        }
        browserApiState.pendingRequests.clear();
    }
    /**
     * 为浏览器脚本到本地服务的 WSS 连接安排一次延迟重连。
     * @param {string} reason - 触发重连的原因。
     */
    function scheduleBrowserApiReconnect(reason) {
        if (browserApiState.manualClose || browserApiState.reconnectTimer) {
            return;
        }
        browserApiState.reconnectTimer = window.setTimeout(() => {
            browserApiState.reconnectTimer = null;
            connectBrowserApiSocket().catch((error) => {
                console.warn('[QN] browser api reconnect failed:', reason, error.message || error);
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
        }
        catch (_) {
            return;
        }
        if (message?.type !== 'rpc-response' || message?.id == null) {
            return;
        }
        const pending = browserApiState.pendingRequests.get(String(message.id));
        if (!pending) {
            return;
        }
        window.clearTimeout(pending.timerId);
        browserApiState.pendingRequests.delete(String(message.id));
        if (message.ok) {
            pending.resolve(message.payload);
            return;
        }
        pending.reject(new Error(message.error || 'browser api request failed'));
    }
    /**
     * 建立到本地 Node 服务的单条 WSS 长连接。
     * @returns {Promise<WebSocket>} 已经连通的 WebSocket。
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
                if (settled)
                    return;
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
        return new Promise((resolve, reject) => {
            const timerId = window.setTimeout(() => {
                browserApiState.pendingRequests.delete(requestId);
                reject(new Error(`browser api request timeout: ${action}`));
            }, timeoutMs);
            browserApiState.pendingRequests.set(requestId, {
                resolve,
                reject,
                timerId,
            });
            try {
                socket.send(JSON.stringify({
                    type: 'rpc-request',
                    id: requestId,
                    action,
                    payload,
                }));
            }
            catch (error) {
                window.clearTimeout(timerId);
                browserApiState.pendingRequests.delete(requestId);
                reject(error);
            }
        });
    }
    /**
     * 在页面卸载前主动关闭浏览器脚本到本地服务的 WSS 连接。
     */
    function closeBrowserApiSocket() {
        browserApiState.manualClose = true;
        if (browserApiState.reconnectTimer) {
            window.clearTimeout(browserApiState.reconnectTimer);
            browserApiState.reconnectTimer = null;
        }
        rejectPendingBrowserApiRequests('browser api socket disposed');
        if (browserApiState.socket) {
            try {
                browserApiState.socket.close(1000, 'page unload');
            }
            catch (_) { /* ignore */ }
            browserApiState.socket = null;
        }
        browserApiState.connectPromise = null;
    }
    /**
     * 创建脚本浮层，展示连接状态、同步结果与手动同步入口。
     */
    function createPanel() {
        if (document.getElementById(CONFIG.panelId)) {
            return;
        }
        const panel = document.createElement('div');
        panel.id = CONFIG.panelId;
        panel.style.cssText = [
            'position:fixed',
            'right:20px',
            'bottom:20px',
            'width:320px',
            'padding:14px 16px',
            'border-radius:16px',
            'background:rgba(14,20,31,0.94)',
            'border:1px solid rgba(78,98,133,0.35)',
            'box-shadow:0 18px 40px rgba(0,0,0,0.28)',
            'backdrop-filter:blur(12px)',
            'z-index:999999',
            'color:#e2e8f8',
            'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        ].join(';');
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <div id="qn-panel-dot" style="width:9px;height:9px;border-radius:50%;background:#f87171;box-shadow:0 0 12px #f87171;"></div>
                    <strong style="font-size:13px;letter-spacing:.2px;">千牛订单同步 v${SCRIPT_VERSION}</strong>
                </div>
                <button id="qn-panel-sync-btn" style="border:none;border-radius:999px;padding:6px 12px;background:linear-gradient(135deg,#f0c020,#ffdd57);color:#111;font-weight:700;cursor:pointer;">立即同步</button>
            </div>
            <div id="qn-panel-body" style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;"></div>
            <div id="qn-panel-footer" style="margin-top:10px;font-size:11px;color:#96a6c1;"></div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('#qn-panel-sync-btn').addEventListener('click', () => {
            scheduleCurrentPageSync({ force: true });
        });
        renderPanel();
    }
    /**
     * 刷新脚本浮层，展示当前连接状态、同步时间与全量扫描摘要。
     */
    function renderPanel() {
        const panel = document.getElementById(CONFIG.panelId);
        if (!panel)
            return;
        const dot = panel.querySelector('#qn-panel-dot');
        const body = panel.querySelector('#qn-panel-body');
        const footer = panel.querySelector('#qn-panel-footer');
        const syncButton = panel.querySelector('#qn-panel-sync-btn');
        const stats = state.lastSyncResult || { inserted: 0, updated: 0, matched: 0, unmatched: 0 };
        const scanSummary = state.lastScanSummary
            ? `上次全量扫描：${state.lastScanSummary.pages} 页 / ${state.lastScanSummary.orders} 单`
            : '尚未执行全量扫描';
        dot.style.background = state.online ? '#34d399' : '#f87171';
        dot.style.boxShadow = `0 0 12px ${state.online ? '#34d399' : '#f87171'}`;
        syncButton.disabled = state.syncBusy;
        syncButton.textContent = state.syncBusy ? '同步中…' : '立即同步';
        syncButton.style.opacity = state.syncBusy ? '0.75' : '1';
        body.innerHTML = `
            <div style="padding:8px 10px;border-radius:12px;background:rgba(28,42,64,0.72);">
                <div style="color:#96a6c1;">连接状态</div>
                <div style="margin-top:2px;font-size:13px;font-weight:700;color:${state.online ? '#34d399' : '#fda4af'};">${state.online ? '已连接本地服务' : '等待本地服务'}</div>
            </div>
            <div style="padding:8px 10px;border-radius:12px;background:rgba(28,42,64,0.72);">
                <div style="color:#96a6c1;">当前页订单</div>
                <div style="margin-top:2px;font-size:13px;font-weight:700;">${state.visibleOrderCount}</div>
            </div>
            <div style="padding:8px 10px;border-radius:12px;background:rgba(28,42,64,0.72);">
                <div style="color:#96a6c1;">最近同步</div>
                <div style="margin-top:2px;font-size:13px;font-weight:700;">${formatDateTime(state.lastSyncAt)}</div>
            </div>
            <div style="padding:8px 10px;border-radius:12px;background:rgba(28,42,64,0.72);">
                <div style="color:#96a6c1;">匹配结果</div>
                <div style="margin-top:2px;font-size:13px;font-weight:700;">${stats.matched || 0} 关联 / ${stats.unmatched || 0} 未关联</div>
            </div>
        `;
        footer.textContent = state.scanState === 'scanning'
            ? '全量扫描进行中…'
            : `${scanSummary} · 插入 ${stats.inserted || 0} / 更新 ${stats.updated || 0}`;
    }
    /**
     * 返回当前页订单列表根节点，优先命中你给出的稳定容器类名。
     * @returns {HTMLElement | null} 当前页订单列表容器。
     */
    function getOrderListRoot() {
        return Array.from(document.querySelectorAll(CONFIG.orderListContainerSelector))
            .find(el => isElementVisible(el))
            || Array.from(document.querySelectorAll('[class*="sc-dAlyuH"]'))
                .find(el => isElementVisible(el) && el.querySelector(CONFIG.orderCardSelector))
            || null;
    }
    /**
     * 等待千牛待发货页面的订单列表区域首屏加载完成。
     * @returns {Promise<boolean>} 是否在超时前等到订单列表容器。
     */
    async function waitForPageReady() {
        const deadline = Date.now() + CONFIG.pageReadyTimeoutMs;
        while (Date.now() < deadline) {
            if (getOrderListRoot()) {
                return true;
            }
            await sleep(300);
        }
        return false;
    }
    /**
     * 从链接地址中提取所有查询参数，供订单字段 fallback 使用。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {{ hrefs: string[], params: Record<string, string> }} 链接元数据。
     */
    function collectLinkMetadata(cardEl) {
        const hrefs = [];
        const params = {};
        for (const anchor of Array.from(cardEl.querySelectorAll('a[href]'))) {
            const href = anchor.href || '';
            if (!href)
                continue;
            hrefs.push(href);
            try {
                const url = new URL(href, location.href);
                for (const [key, value] of url.searchParams.entries()) {
                    if (!(key in params) && normalizeText(value)) {
                        params[key] = normalizeText(value);
                    }
                }
            }
            catch (_) {
                /* ignore malformed href */
            }
        }
        return { hrefs, params };
    }
    /**
     * 从元素及其祖先节点中汇总 data-* 属性，作为字段 fallback。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {Record<string, string>} 收集到的数据属性键值对。
     */
    function collectDatasetFallback(cardEl) {
        const dataset = {};
        let current = cardEl;
        let depth = 0;
        while (current && depth < 4) {
            for (const [key, value] of Object.entries(current.dataset || {})) {
                if (!(key in dataset) && normalizeText(value)) {
                    dataset[key] = normalizeText(value);
                }
            }
            current = current.parentElement;
            depth += 1;
        }
        return dataset;
    }
    /**
     * 递归扫描 React props / fiber 中的订单对象，并提取可序列化摘要。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {Record<string, any>} 精简后的 React 摘要。
     */
    function extractReactOrderSummary(cardEl) {
        const queue = [];
        const seen = new Set();
        Object.keys(cardEl).forEach((key) => {
            if (key.startsWith('__reactFiber') || key.startsWith('__reactProps')) {
                queue.push(cardEl[key]);
            }
        });
        while (queue.length > 0 && seen.size < 250) {
            const current = queue.shift();
            if (!current || typeof current !== 'object' || seen.has(current)) {
                continue;
            }
            seen.add(current);
            const candidate = current.memoizedProps?.record
                || current.memoizedProps?.order
                || current.pendingProps?.record
                || current.pendingProps?.order
                || current.record
                || current.order;
            if (candidate && typeof candidate === 'object') {
                const orderId = normalizeText(candidate.orderId || candidate.bizOrderId || candidate.mainOrderId || '');
                return {
                    orderId,
                    buyerName: normalizeText(candidate.buyerName || candidate.buyerNick || candidate.buyerNickName || ''),
                    buyerUserId: normalizeText(candidate.buyerUserId || candidate.buyerId || candidate.userId || ''),
                    productId: normalizeProductId(candidate.productId || candidate.itemId || candidate.auctionId || '', orderId),
                    productTitle: normalizeText(candidate.productTitle || candidate.title || candidate.itemTitle || ''),
                    productPrice: normalizePriceText(candidate.productPrice || candidate.price || candidate.actualFee || candidate.payAmount || ''),
                    purchaseQuantity: normalizeQuantityText(candidate.purchaseQuantity || candidate.quantity || candidate.num || candidate.buyAmount || ''),
                    receiverName: normalizeText(candidate.receiverName || candidate.consignee || ''),
                    receiverPhone: normalizeText(candidate.receiverPhone || candidate.receiverMobile || candidate.mobile || ''),
                    receiverAddress: normalizeText(candidate.receiverAddress || candidate.address || ''),
                    orderStatusText: normalizeText(candidate.orderStatusText || candidate.orderStatus || candidate.statusDesc || ''),
                    paidAtText: normalizeText(candidate.paidAt || candidate.payTime || candidate.payTimeStr || ''),
                    latestShipAtText: normalizeText(candidate.latestShipAt || candidate.latestConsignTime || candidate.consignDeadline || ''),
                };
            }
            for (const value of Object.values(current).slice(0, 30)) {
                if (!value || typeof value !== 'object')
                    continue;
                if (value.nodeType || value.ownerDocument)
                    continue;
                queue.push(value);
            }
        }
        return {};
    }
    /**
     * 将卡片文本拆成稳定的非空行，便于后续按顺序提取字段。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {string[]} 归一化后的文本行数组。
     */
    function readCardTextLines(cardEl) {
        return String(cardEl.innerText || '')
            .split(/\n+/)
            .map(line => normalizeText(line))
            .filter(Boolean);
    }
    /**
     * 从订单卡片文本中提取订单编号。
     * @param {string[]} lines - 订单卡片文本行。
     * @returns {string | null} 订单编号。
     */
    function extractOrderIdFromLines(lines) {
        for (const line of lines) {
            const match = line.match(/订单编号[:：]?\s*(\d{10,})/);
            if (match) {
                return match[1];
            }
        }
        return null;
    }
    /**
     * 从订单卡片文本行中提取指定标签对应的时间文案。
     * @param {string[]} lines - 订单卡片文本行。
     * @param {string} label - 目标标签。
     * @returns {string | null} 命中的时间文案。
     */
    function extractLabeledTime(lines, label) {
        const pattern = new RegExp(`${label}[:：]?\\s*(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}(?::\\d{2})?)`);
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const match = line.match(pattern);
            if (match) {
                return match[1];
            }
            if (normalizeText(line) === label) {
                const nextLine = normalizeText(lines[index + 1] || '');
                if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(nextLine)) {
                    return nextLine;
                }
            }
        }
        return null;
    }
    /**
     * 从卡片 DOM 结构中按标签提取文本，兼容“标签和值分两行”的布局。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @param {string} label - 目标标签文本。
     * @param {RegExp | null} valuePattern - 值的匹配规则。
     * @returns {string | null} 命中的文本值。
     */
    function extractLabeledValueFromCard(cardEl, label, valuePattern = null) {
        const labelElements = Array.from(cardEl.querySelectorAll('div, span'))
            .filter(el => normalizeText(el.textContent) === label);
        for (const labelEl of labelElements) {
            const candidates = [
                labelEl.nextElementSibling,
                labelEl.parentElement?.nextElementSibling || null,
                labelEl.closest('div')?.nextElementSibling || null,
                ...Array.from(labelEl.parentElement?.parentElement?.children || []).filter(child => !child.contains(labelEl)),
            ];
            for (const candidate of candidates) {
                const textPool = [];
                if (candidate) {
                    textPool.push(normalizeText(candidate.textContent));
                    textPool.push(...Array.from(candidate.querySelectorAll('div, span')).map(node => normalizeText(node.textContent)));
                }
                for (const text of textPool.filter(Boolean)) {
                    if (text === label) {
                        continue;
                    }
                    if (valuePattern && !valuePattern.test(text)) {
                        continue;
                    }
                    return text;
                }
            }
        }
        return null;
    }
    /**
     * 从订单卡片可见文本中提取商品 ID。
     * @param {string[]} lines - 订单卡片文本行。
     * @param {string | null} orderId - 当前订单号。
     * @returns {string | null} 商品 ID。
     */
    function extractProductIdFromLines(lines, orderId = null) {
        for (const line of lines) {
            const match = normalizeText(line).match(/商品\s*ID[:：]?\s*(\d{6,20})/i);
            if (match) {
                const productId = normalizeProductId(match[1], orderId);
                if (productId) {
                    return productId;
                }
            }
        }
        return null;
    }
    /**
     * 从订单卡片中提取商品金额和购买数量。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @param {string[]} lines - 订单卡片文本行。
     * @returns {{productPrice: string|null, purchaseQuantity: string|null, rawLine: string|null}} 金额与数量结果。
     */
    function extractPriceQuantityFromCard(cardEl, lines) {
        const linePool = [
            ...lines,
            normalizeText(cardEl.innerText),
            ...Array.from(cardEl.querySelectorAll('[role="gridcell"], div, span')).map(el => normalizeText(el.textContent)),
        ].filter(Boolean);
        for (const line of linePool) {
            const match = line.match(/[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)\s*x\s*(\d+)/i);
            if (match) {
                return {
                    productPrice: normalizePriceText(match[1]),
                    purchaseQuantity: normalizeQuantityText(match[2]),
                    rawLine: line,
                };
            }
        }
        return {
            productPrice: null,
            purchaseQuantity: null,
            rawLine: null,
        };
    }
    /**
     * 从卡片头部的稳定 DOM 中读取订单编号。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {string | null} 订单编号。
     */
    function readOrderIdFromCard(cardEl) {
        const headerTexts = Array.from(cardEl.querySelectorAll('.header-wrapper .hearder-left, .header-wrapper span'))
            .map(el => normalizeText(el.textContent))
            .filter(Boolean);
        return extractOrderIdFromLines(headerTexts) || extractOrderIdFromLines(readCardTextLines(cardEl));
    }
    /**
     * 将相对链接或协议相对链接归一化为绝对 URL。
     * @param {string | null | undefined} href - 原始链接地址。
     * @returns {string | null} 绝对 URL。
     */
    function resolveAbsoluteUrl(href) {
        const normalizedHref = normalizeText(href);
        if (!normalizedHref) {
            return null;
        }
        try {
            return new URL(normalizedHref, location.href).toString();
        }
        catch (_) {
            return null;
        }
    }
    /**
     * 从订单卡片中提取 tradeSnap 快照页链接。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {string | null} 商品快照页绝对 URL。
     */
    function extractTradeSnapshotUrl(cardEl) {
        const anchor = cardEl.querySelector('a[href*="trade.taobao.com/trade/detail/tradeSnap.htm"], a[href*="tradeSnap.htm"]');
        return resolveAbsoluteUrl(anchor?.getAttribute('href') || anchor?.href || '');
    }
    /**
     * 从 tradeSnap 快照页链接中提取 tradeId，便于写回 raw 追踪。
     * @param {string | null} tradeSnapshotUrl - tradeSnap 链接。
     * @returns {string | null} tradeId。
     */
    function extractTradeIdFromTradeSnapshotUrl(tradeSnapshotUrl) {
        if (!tradeSnapshotUrl) {
            return null;
        }
        try {
            const url = new URL(tradeSnapshotUrl);
            return normalizeText(url.searchParams.get('tradeId'));
        }
        catch (_) {
            return null;
        }
    }
    /**
     * 从订单卡片里的链接集合中提取商品 ID，优先识别商品详情页参数。
     * @param {{ hrefs: string[] }} links - 卡片链接元数据。
     * @param {string | null} orderId - 当前订单号。
     * @returns {string | null} 商品 ID。
     */
    function extractProductIdFromLinks(links, orderId = null) {
        for (const href of Array.isArray(links?.hrefs) ? links.hrefs : []) {
            try {
                const url = new URL(href, location.href);
                const directKeys = ['itemId', 'auctionId', 'item_id', 'auction_id'];
                for (const key of directKeys) {
                    const directId = normalizeProductId(url.searchParams.get(key), orderId);
                    if (directId) {
                        return directId;
                    }
                }
                if (/item\.htm|auction\.htm/i.test(url.pathname)) {
                    const detailId = normalizeProductId(url.searchParams.get('id'), orderId);
                    if (detailId) {
                        return detailId;
                    }
                }
                const pathMatch = url.pathname.match(/\/i(\d+)\.htm/i)
                    || url.pathname.match(/\/item\/(\d+)/i);
                const pathId = normalizeProductId(pathMatch?.[1], orderId);
                if (pathId) {
                    return pathId;
                }
            }
            catch (_) {
                /* ignore malformed href */
            }
        }
        return null;
    }
    /**
     * 将多种来源的候选值按“可见文本 -> 链接参数 -> data-* -> React props”优先级收敛为单值。
     * @param {...(string|null|undefined)} candidates - 候选字段值列表。
     * @returns {string | null} 选中的字段值。
     */
    function pickPreferredField(...candidates) {
        for (const candidate of candidates) {
            const normalized = normalizeText(candidate);
            if (normalized) {
                return normalized;
            }
        }
        return null;
    }
    /**
     * 在两个候选文本之间优先保留信息更完整的值，避免用掩码文本覆盖已解密结果。
     * @param {string | null | undefined} currentValue - 现有字段值。
     * @param {string | null | undefined} nextValue - 新候选字段值。
     * @returns {string | null} 更优的字段值。
     */
    function preferBetterField(currentValue, nextValue) {
        const currentText = normalizeText(currentValue);
        const nextText = normalizeText(nextValue);
        if (!currentText) {
            return nextText || null;
        }
        if (!nextText) {
            return currentText || null;
        }
        const currentMasked = containsMaskedValue(currentText);
        const nextMasked = containsMaskedValue(nextText);
        if (currentMasked && !nextMasked) {
            return nextText;
        }
        if (nextText.length > currentText.length) {
            return nextText;
        }
        return currentText;
    }
    /**
     * 从订单卡片页脚的地址文本中拆出地址、姓名与电话。
     * @param {string} rawText - 页脚地址文本。
     * @returns {{receiverAddress: string|null, receiverName: string|null, receiverPhone: string|null, rawText: string|null}} 拆解结果。
     */
    function extractReceiverInfoFromText(rawText) {
        const normalized = normalizeText(rawText);
        if (!normalized) {
            return {
                receiverAddress: null,
                receiverName: null,
                receiverPhone: null,
                rawText: null,
            };
        }
        const parts = normalized
            .split(/[，,]/)
            .map(part => normalizeText(part))
            .filter(Boolean);
        return {
            receiverAddress: parts[0] || null,
            receiverName: parts[1] || null,
            receiverPhone: parts[2] || null,
            rawText: normalized,
        };
    }
    /**
     * 从卡片页脚的真实 DOM 中读取当前显示的买家信息文本。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {{receiverAddress: string|null, receiverName: string|null, receiverPhone: string|null, rawText: string|null}} 当前页脚地址信息。
     */
    function extractReceiverInfoFromCard(cardEl) {
        const footer = cardEl.querySelector('.footer-wrapper');
        if (!footer) {
            return extractReceiverInfoFromText('');
        }
        const candidateText = Array.from(footer.querySelectorAll('span, div'))
            .map(el => normalizeText(el.textContent))
            .find(text => {
            return text
                && !/解密|修改|快捷发货|订单发货/.test(text)
                && /[，,]/.test(text)
                && text.length >= 8;
        }) || '';
        return extractReceiverInfoFromText(candidateText);
    }
    /**
     * 判断某个字段是否仍然包含掩码星号。
     * @param {string | null | undefined} value - 待判断文本。
     * @returns {boolean} 是否仍然是掩码文本。
     */
    function containsMaskedValue(value) {
        return /[*＊]{2,}/.test(normalizeText(value));
    }
    /**
     * 判断当前买家信息是否已经是完整的解密结果。
     * @param {{receiverAddress?: string|null, receiverName?: string|null, receiverPhone?: string|null}} info - 当前买家信息。
     * @returns {boolean} 是否可以认为已经成功解密。
     */
    function isReceiverInfoComplete(info = {}) {
        return !!(normalizeText(info.receiverAddress)
            && normalizeText(info.receiverName)
            && normalizeText(info.receiverPhone)
            && !containsMaskedValue(info.receiverAddress)
            && !containsMaskedValue(info.receiverPhone));
    }
    /**
     * 给买家信息打一个轻量分数，便于在多次轮询中保留最完整结果。
     * @param {{receiverAddress?: string|null, receiverName?: string|null, receiverPhone?: string|null}} info - 当前买家信息。
     * @returns {number} 信息完整度分数。
     */
    function scoreReceiverInfo(info = {}) {
        const fields = [info.receiverAddress, info.receiverName, info.receiverPhone];
        return fields.reduce((score, field) => {
            const normalized = normalizeText(field);
            if (!normalized) {
                return score;
            }
            return score + (containsMaskedValue(normalized) ? 1 : 2);
        }, 0);
    }
    /**
     * 将一份买家信息合并回订单对象，优先保留更完整的已解密文本。
     * @param {Record<string, any>} order - 当前订单对象。
     * @param {{receiverAddress?: string|null, receiverName?: string|null, receiverPhone?: string|null}} receiverInfo - 待合并的买家信息。
     */
    function applyReceiverInfoToOrder(order, receiverInfo = {}) {
        order.receiverAddress = preferBetterField(order.receiverAddress, receiverInfo.receiverAddress);
        order.receiverName = preferBetterField(order.receiverName, receiverInfo.receiverName);
        order.receiverPhone = preferBetterField(order.receiverPhone, receiverInfo.receiverPhone);
    }
    /**
     * 从订单卡片中提取当前页可见的基础字段，再叠加已缓存的增强结果。
     * @param {HTMLElement} cardEl - 订单卡片节点。
     * @returns {Record<string, any> | null} 基础订单对象。
     */
    function buildBaseOrderFromCard(cardEl) {
        const lines = readCardTextLines(cardEl);
        const links = collectLinkMetadata(cardEl);
        const dataset = collectDatasetFallback(cardEl);
        const reactSummary = extractReactOrderSummary(cardEl);
        const receiverInfo = extractReceiverInfoFromCard(cardEl);
        const priceQuantity = extractPriceQuantityFromCard(cardEl, lines);
        const wwNode = cardEl.querySelector('.ww-light[data-encryptuid]');
        const tradeSnapshotUrl = extractTradeSnapshotUrl(cardEl);
        const tradeId = extractTradeIdFromTradeSnapshotUrl(tradeSnapshotUrl);
        const orderId = pickPreferredField(readOrderIdFromCard(cardEl), extractOrderIdFromLines(lines), links.params.orderId, links.params.bizOrderId, links.params.tradeId, dataset.orderId, reactSummary.orderId);
        const cached = readOrderEnrichmentCache(orderId);
        if (!orderId) {
            return null;
        }
        const order = {
            orderId,
            buyerName: pickPreferredField(cached.buyerName, wwNode?.dataset?.tnick, wwNode?.dataset?.nick, reactSummary.buyerName),
            buyerUserId: pickPreferredField(cached.buyerUserId, wwNode?.dataset?.encryptuid, dataset.encryptuid, reactSummary.buyerUserId),
            productId: pickPreferredField(extractProductIdFromLines(lines, orderId), extractProductIdFromLinks(links, orderId), normalizeProductId(dataset.productId, orderId), normalizeProductId(dataset.itemId, orderId), normalizeProductId(dataset.auctionId, orderId), normalizeProductId(reactSummary.productId, orderId), normalizeProductId(cached.productId, orderId)),
            productTitle: pickPreferredField(cached.productTitle, normalizeText(cardEl.querySelector('a[href*="tradeSnap.htm"] div')?.textContent), normalizeText(cardEl.querySelector('a[href*="tradeSnap.htm"]')?.textContent), dataset.productTitle, reactSummary.productTitle),
            productPrice: pickPreferredField(normalizePriceText(dataset.productPrice), priceQuantity.productPrice, reactSummary.productPrice),
            purchaseQuantity: pickPreferredField(normalizeQuantityText(dataset.purchaseQuantity), priceQuantity.purchaseQuantity, reactSummary.purchaseQuantity),
            receiverName: pickPreferredField(cached.receiverName, receiverInfo.receiverName, reactSummary.receiverName),
            receiverPhone: pickPreferredField(cached.receiverPhone, receiverInfo.receiverPhone, reactSummary.receiverPhone),
            receiverAddress: pickPreferredField(cached.receiverAddress, receiverInfo.receiverAddress, reactSummary.receiverAddress),
            orderStatusText: pickPreferredField(lines.find(line => /已支付|待发货|待处理|待揽收|待配送/.test(line)), dataset.orderStatusText, reactSummary.orderStatusText),
            paidAtText: pickPreferredField(extractLabeledValueFromCard(cardEl, '支付时间', /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/), extractLabeledTime(lines, '支付时间'), dataset.paidAt, reactSummary.paidAtText),
            latestShipAtText: pickPreferredField(extractLabeledValueFromCard(cardEl, '最晚发货时间', /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/), extractLabeledTime(lines, '最晚发货时间'), dataset.latestShipAt, reactSummary.latestShipAtText),
            raw: {
                textLines: lines,
                hrefs: links.hrefs,
                linkParams: links.params,
                dataset,
                reactSummary,
                priceQuantityLine: priceQuantity.rawLine,
                receiverLine: receiverInfo.rawText,
                wwMeta: wwNode ? {
                    encryptuid: normalizeText(wwNode.dataset.encryptuid),
                    nick: normalizeText(wwNode.dataset.nick),
                    tnick: normalizeText(wwNode.dataset.tnick),
                } : null,
                tradeSnapshotUrl,
                tradeId,
                cacheSnapshot: cached,
            },
        };
        patchOrderEnrichmentCache(orderId, {
            buyerName: order.buyerName,
            buyerUserId: order.buyerUserId,
            productTitle: order.productTitle,
            tradeSnapshotUrl,
            tradeId,
        });
        return order;
    }
    /**
     * 通过 Tampermonkey 跨域请求或普通 fetch 拉取页面 HTML，供 tradeSnap 商品 ID 解析使用。
     * @param {string} url - 目标页面地址。
     * @returns {Promise<string>} 拉取到的 HTML 字符串。
     */
    function requestPageHtml(url) {
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: CONFIG.detailRequestTimeoutMs,
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            resolve(response.responseText || '');
                            return;
                        }
                        reject(new Error(`request failed: ${response.status}`));
                    },
                    onerror: () => reject(new Error('request failed')),
                    ontimeout: () => reject(new Error('request timeout')),
                });
            });
        }
        return window.fetch(url, { credentials: 'include' })
            .then((response) => {
            if (!response.ok) {
                throw new Error(`request failed: ${response.status}`);
            }
            return response.text();
        });
    }
    /**
     * 从 tradeSnap 快照页 HTML 中解析商品 ID。
     * @param {string} html - tradeSnap 页面 HTML。
     * @returns {string | null} 商品 ID。
     */
    function extractProductIdFromTradeSnapshotHtml(html, orderId = null) {
        const doc = new DOMParser().parseFromString(html || '', 'text/html');
        const keyValueRows = Array.from(doc.querySelectorAll('.summary-r.fl p.key-value, p.key-value'));
        for (const row of keyValueRows) {
            const nameText = normalizeText(row.querySelector('.name')?.textContent || '');
            if (nameText !== '商品ID') {
                continue;
            }
            const valueText = normalizeText(row.querySelector('.value-inline')?.textContent
                || row.querySelector('.value')?.textContent
                || row.textContent.replace(nameText, ''));
            const productId = normalizeProductId(valueText, orderId);
            if (productId) {
                return productId;
            }
        }
        const textMatch = normalizeText(doc.body?.innerText || '').match(/商品\s*ID[:：]?\s*(\d{6,20})/i);
        if (textMatch) {
            const productId = normalizeProductId(textMatch[1], orderId);
            if (productId) {
                return productId;
            }
        }
        const htmlText = String(html || '');
        const sourceMatch = htmlText.match(/(?:itemId|auctionId|item_id|auction_id)["'=:\s>]+["']?(\d{6,20})/i);
        if (sourceMatch) {
            const productId = normalizeProductId(sourceMatch[1], orderId);
            if (productId) {
                return productId;
            }
        }
        const detailLinkMatch = htmlText.match(/item\.htm\?id=(\d{6,20})/i);
        return normalizeProductId(detailLinkMatch?.[1], orderId);
    }
    /**
     * 确保订单已经补齐商品 ID；命中缓存时直接复用，否则访问 tradeSnap 页抓取后缓存。
     * @param {Record<string, any>} order - 当前订单对象。
     * @returns {Promise<string | null>} 最终商品 ID。
     */
    async function ensureProductIdForOrder(order) {
        if (!order?.orderId) {
            return null;
        }
        if (normalizeText(order.productId)) {
            patchOrderEnrichmentCache(order.orderId, {
                productId: order.productId,
                productIdCompleted: true,
                productIdLastAttemptAt: Date.now(),
            });
            return order.productId;
        }
        const cached = readOrderEnrichmentCache(order.orderId);
        if (normalizeText(cached.productId)) {
            order.productId = normalizeText(cached.productId);
            return order.productId;
        }
        const tradeSnapshotUrl = normalizeText(order.raw?.tradeSnapshotUrl || cached.tradeSnapshotUrl);
        if (!tradeSnapshotUrl) {
            return null;
        }
        const lastAttemptAt = Number(cached.productIdLastAttemptAt || 0);
        if (lastAttemptAt > 0
            && (Date.now() - lastAttemptAt) < CONFIG.detailRetryCooldownMs
            && !normalizeText(cached.productId)) {
            return null;
        }
        if (enrichmentState.productIdRequests.has(order.orderId)) {
            const sharedProductId = await enrichmentState.productIdRequests.get(order.orderId);
            if (sharedProductId) {
                order.productId = sharedProductId;
            }
            return sharedProductId;
        }
        const requestPromise = (async () => {
            patchOrderEnrichmentCache(order.orderId, {
                tradeSnapshotUrl,
                productIdLastAttemptAt: Date.now(),
            });
            try {
                const html = await requestPageHtml(tradeSnapshotUrl);
                const productId = extractProductIdFromTradeSnapshotHtml(html, order.orderId);
                if (productId) {
                    patchOrderEnrichmentCache(order.orderId, {
                        tradeSnapshotUrl,
                        productId,
                        productIdCompleted: true,
                        productIdLastAttemptAt: Date.now(),
                    });
                    return productId;
                }
            }
            catch (error) {
                console.warn('[QN] resolve product id failed:', order.orderId, error.message || error);
            }
            patchOrderEnrichmentCache(order.orderId, {
                tradeSnapshotUrl,
                productIdCompleted: false,
                productIdLastAttemptAt: Date.now(),
            });
            return null;
        })();
        enrichmentState.productIdRequests.set(order.orderId, requestPromise);
        try {
            const productId = await requestPromise;
            if (productId) {
                order.productId = productId;
            }
            return productId;
        }
        finally {
            enrichmentState.productIdRequests.delete(order.orderId);
        }
    }
    /**
     * 对指定订单执行一次“解密”动作，并在成功拿到完整买家信息后按 orderId 打标缓存。
     * @param {Record<string, any>} order - 当前订单对象。
     * @param {HTMLElement} cardEl - 对应订单卡片节点。
     * @returns {Promise<{receiverAddress: string|null, receiverName: string|null, receiverPhone: string|null}>} 最新买家信息。
     */
    async function ensureReceiverInfoForOrder(order, cardEl) {
        if (!order?.orderId) {
            return extractReceiverInfoFromText('');
        }
        const cached = readOrderEnrichmentCache(order.orderId);
        const currentInfo = {
            receiverAddress: order.receiverAddress,
            receiverName: order.receiverName,
            receiverPhone: order.receiverPhone,
        };
        if (isReceiverInfoComplete(currentInfo)) {
            patchOrderEnrichmentCache(order.orderId, {
                receiverAddress: currentInfo.receiverAddress,
                receiverName: currentInfo.receiverName,
                receiverPhone: currentInfo.receiverPhone,
                decryptCompleted: true,
                decryptLastAttemptAt: Date.now(),
            });
            return currentInfo;
        }
        if (isReceiverInfoComplete(cached)) {
            return {
                receiverAddress: cached.receiverAddress || null,
                receiverName: cached.receiverName || null,
                receiverPhone: cached.receiverPhone || null,
            };
        }
        const lastAttemptAt = Number(cached.decryptLastAttemptAt || 0);
        if (lastAttemptAt > 0
            && (Date.now() - lastAttemptAt) < CONFIG.decryptRetryCooldownMs
            && !cached.decryptCompleted) {
            return {
                receiverAddress: cached.receiverAddress || currentInfo.receiverAddress || null,
                receiverName: cached.receiverName || currentInfo.receiverName || null,
                receiverPhone: cached.receiverPhone || currentInfo.receiverPhone || null,
            };
        }
        if (enrichmentState.decryptRequests.has(order.orderId)) {
            return await enrichmentState.decryptRequests.get(order.orderId);
        }
        const requestPromise = (async () => {
            const beforeInfo = extractReceiverInfoFromCard(cardEl);
            if (isReceiverInfoComplete(beforeInfo)) {
                patchOrderEnrichmentCache(order.orderId, {
                    receiverAddress: beforeInfo.receiverAddress,
                    receiverName: beforeInfo.receiverName,
                    receiverPhone: beforeInfo.receiverPhone,
                    decryptCompleted: true,
                    decryptLastAttemptAt: Date.now(),
                });
                return beforeInfo;
            }
            patchOrderEnrichmentCache(order.orderId, {
                receiverAddress: preferBetterField(cached.receiverAddress, beforeInfo.receiverAddress),
                receiverName: preferBetterField(cached.receiverName, beforeInfo.receiverName),
                receiverPhone: preferBetterField(cached.receiverPhone, beforeInfo.receiverPhone),
                decryptLastAttemptAt: Date.now(),
            });
            const decryptButton = Array.from(cardEl.querySelectorAll('button, span.next-btn-helper'))
                .find(el => normalizeText(el.textContent) === '解密');
            const clickTarget = decryptButton ? (decryptButton.closest('button') || decryptButton) : null;
            if (!clickTarget) {
                return beforeInfo;
            }
            clickElementSafely(clickTarget);
            let bestInfo = beforeInfo;
            const deadline = Date.now() + CONFIG.decryptWaitTimeoutMs;
            while (Date.now() < deadline) {
                await sleep(CONFIG.decryptPollIntervalMs);
                const nextInfo = extractReceiverInfoFromCard(cardEl);
                if (scoreReceiverInfo(nextInfo) > scoreReceiverInfo(bestInfo)) {
                    bestInfo = nextInfo;
                }
                if (isReceiverInfoComplete(nextInfo)) {
                    patchOrderEnrichmentCache(order.orderId, {
                        receiverAddress: nextInfo.receiverAddress,
                        receiverName: nextInfo.receiverName,
                        receiverPhone: nextInfo.receiverPhone,
                        decryptCompleted: true,
                        decryptLastAttemptAt: Date.now(),
                    });
                    return nextInfo;
                }
            }
            patchOrderEnrichmentCache(order.orderId, {
                receiverAddress: preferBetterField(cached.receiverAddress, bestInfo.receiverAddress),
                receiverName: preferBetterField(cached.receiverName, bestInfo.receiverName),
                receiverPhone: preferBetterField(cached.receiverPhone, bestInfo.receiverPhone),
                decryptCompleted: false,
                decryptLastAttemptAt: Date.now(),
            });
            return bestInfo;
        })();
        enrichmentState.decryptRequests.set(order.orderId, requestPromise);
        try {
            return await requestPromise;
        }
        finally {
            enrichmentState.decryptRequests.delete(order.orderId);
        }
    }
    /**
     * 以“当前页可见字段 -> 缓存增强字段”的顺序补齐订单完整信息。
     * @param {Record<string, any>} order - 当前订单对象。
     * @param {HTMLElement} cardEl - 对应订单卡片节点。
     * @returns {Promise<Record<string, any>>} 增强后的订单对象。
     */
    async function enrichOrderFromCard(order, cardEl) {
        const receiverInfo = await ensureReceiverInfoForOrder(order, cardEl);
        applyReceiverInfoToOrder(order, receiverInfo);
        const productId = await ensureProductIdForOrder(order);
        if (productId) {
            order.productId = productId;
        }
        order.raw.cacheSnapshot = readOrderEnrichmentCache(order.orderId);
        return order;
    }
    /**
     * 查找当前页面中的订单卡片节点，并按订单编号去重。
     * @returns {HTMLElement[]} 当前页可见订单卡片列表。
     */
    function findOrderCards() {
        const root = getOrderListRoot() || document;
        const candidates = Array.from(root.querySelectorAll(CONFIG.orderCardSelector))
            .filter(el => isElementVisible(el));
        const deduped = new Map();
        for (const candidate of candidates) {
            const orderId = readOrderIdFromCard(candidate);
            if (!orderId) {
                continue;
            }
            const previous = deduped.get(orderId);
            if (!previous || normalizeText(candidate.innerText).length > normalizeText(previous.innerText).length) {
                deduped.set(orderId, candidate);
            }
        }
        return Array.from(deduped.values());
    }
    /**
     * 收集并增强当前页所有订单快照；已命中缓存的订单不会重复触发解密与详情抓取。
     * @returns {Promise<Record<string, any>[]>} 可上传的订单数组。
     */
    async function collectCurrentPageOrders() {
        const cards = findOrderCards();
        state.visibleOrderCount = cards.length;
        const orders = [];
        for (const cardEl of cards) {
            const baseOrder = buildBaseOrderFromCard(cardEl);
            if (!baseOrder) {
                continue;
            }
            orders.push(await enrichOrderFromCard(baseOrder, cardEl));
        }
        state.visibleOrderCount = orders.length;
        return orders;
    }
    /**
     * 返回当前页订单集合的轻量签名，用于判断翻页是否真正完成。
     * @returns {string} 当前页订单签名。
     */
    function buildCurrentPageSignature() {
        return findOrderCards()
            .map(cardEl => readOrderIdFromCard(cardEl))
            .filter(Boolean)
            .join('|');
    }
    /**
     * 读取当前分页器所处页码，读取失败时返回 null。
     * @returns {number | null} 当前页码。
     */
    function getCurrentPageNumber() {
        const activePageEl = Array.from(document.querySelectorAll('li, button, a, span'))
            .find(el => /current|active|selected/.test(el.className || '') && /^\d+$/.test(normalizeText(el.textContent)));
        if (activePageEl) {
            return Number(normalizeText(activePageEl.textContent));
        }
        const pageFromUrl = new URL(location.href).searchParams.get('pageNo')
            || new URL(location.href).searchParams.get('page')
            || '';
        return /^\d+$/.test(pageFromUrl) ? Number(pageFromUrl) : null;
    }
    /**
     * 查找指定页码对应的分页按钮。
     * @param {number} pageNo - 目标页码。
     * @returns {HTMLElement | null} 匹配到的分页节点。
     */
    function findPaginationButtonByPage(pageNo) {
        return Array.from(document.querySelectorAll('button, a, li, span'))
            .find(el => isElementVisible(el) && normalizeText(el.textContent) === String(pageNo));
    }
    /**
     * 查找“下一页”按钮，并排除已禁用的节点。
     * @returns {HTMLElement | null} 可点击的下一页按钮。
     */
    function findNextPageButton() {
        return Array.from(document.querySelectorAll('button, a, li, span'))
            .find(el => {
            if (!isElementVisible(el))
                return false;
            const text = normalizeText(el.textContent);
            if (!/下一页|下页/.test(text))
                return false;
            const classText = String(el.className || '');
            return !/disabled|forbid|ban/.test(classText);
        }) || null;
    }
    /**
     * 等待订单页发生变化，用于翻页后的稳定检测。
     * @param {string} previousSignature - 翻页前的页签名。
     * @returns {Promise<boolean>} 是否在超时前检测到页内容变化。
     */
    async function waitForPageChange(previousSignature) {
        const deadline = Date.now() + CONFIG.pageChangeTimeoutMs;
        while (Date.now() < deadline) {
            const currentSignature = buildCurrentPageSignature();
            if (currentSignature && currentSignature !== previousSignature) {
                return true;
            }
            await sleep(250);
        }
        return false;
    }
    /**
     * 以安全方式点击分页节点。
     * @param {HTMLElement | null} el - 待点击节点。
     * @returns {boolean} 是否已触发点击。
     */
    function clickElementSafely(el) {
        if (!el)
            return false;
        try {
            el.click();
            return true;
        }
        catch (_) {
            return false;
        }
    }
    /**
     * 上传当前页订单快照，并刷新本地浮层统计。
     * @param {{ mode?: 'current-page'|'full-scan', scanNonce?: string|null, pageNo?: number|null, force?: boolean }} options - 当前同步上下文。
     * @returns {Promise<Record<string, any> | null>} 本次同步结果。
     */
    async function syncCurrentPageOrders(options = {}) {
        if (state.syncBusy && !options.force) {
            return null;
        }
        state.syncBusy = true;
        renderPanel();
        try {
            const orders = await collectCurrentPageOrders();
            const result = await browserApiRequest('orders.ingest', {
                orders,
                pageContext: {
                    mode: options.mode || 'current-page',
                    pageNo: options.pageNo != null ? options.pageNo : getCurrentPageNumber(),
                    scanNonce: options.scanNonce || null,
                    collectedAt: new Date().toISOString(),
                },
            });
            state.lastSyncAt = Math.floor(Date.now() / 1000);
            state.lastSyncResult = result;
            renderPanel();
            return result;
        }
        catch (error) {
            console.warn('[QN] sync current page failed:', error.message || error);
            renderPanel();
            return null;
        }
        finally {
            state.syncBusy = false;
            renderPanel();
        }
    }
    /**
     * 将高频当前页同步合并调度成一次，避免短时间重复解析整页卡片。
     * @param {{ force?: boolean }} options - 是否强制立即执行。
     */
    function scheduleCurrentPageSync(options = {}) {
        if (options.force) {
            if (state.syncTimer) {
                window.clearTimeout(state.syncTimer);
                state.syncTimer = null;
            }
            syncCurrentPageOrders({ mode: 'current-page', force: true });
            return;
        }
        if (state.syncTimer || state.scanState === 'scanning') {
            return;
        }
        state.syncTimer = window.setTimeout(() => {
            state.syncTimer = null;
            syncCurrentPageOrders({ mode: 'current-page' });
        }, CONFIG.syncDebounceMs);
    }
    /**
     * 执行一次来自控制台的“立即同步当前页”请求；成功后在下一次 heartbeat 里回写 handled nonce。
     * @param {string} syncNonce - 本次立即同步请求的 nonce。
     * @returns {Promise<void>}
     */
    async function runImmediateSync(syncNonce) {
        if (!syncNonce || state.scanState === 'scanning') {
            return;
        }
        if (syncNonce === state.lastHandledSyncNowNonce || syncNonce === state.activeSyncNowNonce) {
            return;
        }
        state.activeSyncNowNonce = syncNonce;
        renderPanel();
        // 千牛页面订单数据随页面刷新而更新，因此保存 nonce 后刷新页面
        try {
            localStorage.setItem(CONFIG.pendingSyncNonceStorageKey, syncNonce);
        }
        catch (e) {
            console.warn('[QN] failed to save sync nonce to localStorage:', e);
        }
        location.reload();
    }
    /**
     * 执行一次手动全量扫描：从当前页开始逐页采集，并在结束后尽量回到起始页。
     * @param {string} scanNonce - 本次扫描请求 nonce。
     */
    async function runFullScan(scanNonce) {
        if (!scanNonce || state.scanState === 'scanning') {
            return;
        }
        state.scanState = 'scanning';
        state.activeScanNonce = scanNonce;
        renderPanel();
        const startUrl = location.href;
        const startPageNo = getCurrentPageNumber();
        const summary = { pages: 0, orders: 0, inserted: 0, updated: 0, matched: 0, unmatched: 0 };
        try {
            let hasNext = true;
            while (hasNext) {
                const pageNo = getCurrentPageNumber();
                const result = await syncCurrentPageOrders({
                    mode: 'full-scan',
                    scanNonce,
                    pageNo,
                    force: true,
                });
                if (result) {
                    summary.pages += 1;
                    summary.orders += result.total || 0;
                    summary.inserted += result.inserted || 0;
                    summary.updated += result.updated || 0;
                    summary.matched += result.matched || 0;
                    summary.unmatched += result.unmatched || 0;
                }
                const nextButton = findNextPageButton();
                const previousSignature = buildCurrentPageSignature();
                if (!nextButton || !clickElementSafely(nextButton)) {
                    hasNext = false;
                    break;
                }
                const changed = await waitForPageChange(previousSignature);
                if (!changed) {
                    hasNext = false;
                }
            }
        }
        catch (error) {
            console.warn('[QN] full scan failed:', error.message || error);
        }
        finally {
            state.scanState = 'idle';
            state.lastHandledScanNonce = scanNonce;
            state.lastScanSummary = summary;
            state.activeScanNonce = null;
            if (startPageNo != null && getCurrentPageNumber() !== startPageNo) {
                const startPageButton = findPaginationButtonByPage(startPageNo);
                const previousSignature = buildCurrentPageSignature();
                if (startPageButton && clickElementSafely(startPageButton)) {
                    await waitForPageChange(previousSignature);
                }
                else if (location.href !== startUrl) {
                    location.href = startUrl;
                    return;
                }
            }
            renderPanel();
        }
    }
    /**
     * 向后端上报千牛脚本心跳，并在收到新的 full scan nonce 时启动扫描。
     */
    async function syncHeartbeat() {
        try {
            const visibleOrderCount = findOrderCards().length;
            state.visibleOrderCount = visibleOrderCount;
            const runtime = await browserApiRequest('orders.heartbeat', {
                pageUrl: location.href,
                visibleOrderCount,
                scanState: state.scanState,
                scanNonceHandled: state.lastHandledScanNonce,
                syncNonceHandled: state.lastHandledSyncNowNonce,
            });
            state.online = true;
            renderPanel();
            if (runtime?.syncNowNonce
                && runtime.syncNowNonce !== state.lastHandledSyncNowNonce
                && runtime.syncNowNonce !== state.activeSyncNowNonce
                && state.scanState !== 'scanning') {
                await runImmediateSync(runtime.syncNowNonce);
            }
            if (runtime?.fullScanNonce
                && runtime.fullScanNonce !== state.lastHandledScanNonce
                && runtime.fullScanNonce !== state.activeScanNonce) {
                await runFullScan(runtime.fullScanNonce);
            }
        }
        catch (error) {
            state.online = false;
            renderPanel();
            console.warn('[QN] heartbeat failed:', error.message || error);
        }
    }
    /**
     * 启动当前页定时同步循环；全量扫描期间自动跳过常规同步。
     */
    function startCurrentPageSyncLoop() {
        const loop = async () => {
            if (state.scanState !== 'scanning') {
                await syncCurrentPageOrders({ mode: 'current-page' });
            }
            window.setTimeout(loop, CONFIG.syncIntervalMs);
        };
        window.setTimeout(loop, CONFIG.syncIntervalMs);
    }
    /**
     * 启动脚本心跳循环，维持本地运行态和手动全量扫描指令同步。
     */
    function startHeartbeatLoop() {
        const loop = async () => {
            await syncHeartbeat();
            window.setTimeout(loop, CONFIG.heartbeatIntervalMs);
        };
        loop();
    }
    /**
     * 初始化脚本：等待页面可用、建立 WSS 连接、创建面板并启动轮询。
     */
    async function init() {
        const ready = await waitForPageReady();
        if (!ready) {
            console.warn('[QN] batch-consign page not ready in time');
            return;
        }
        // 恢复 reload 前保存的立即同步 nonce
        let pendingSyncNonce = null;
        try {
            pendingSyncNonce = localStorage.getItem(CONFIG.pendingSyncNonceStorageKey);
            if (pendingSyncNonce) {
                localStorage.removeItem(CONFIG.pendingSyncNonceStorageKey);
            }
        }
        catch (e) { /* ignore */ }
        createPanel();
        connectBrowserApiSocket().catch((error) => {
            console.warn('[QN] browser api socket init failed:', error.message || error);
        });
        scheduleCurrentPageSync({ force: true });
        startHeartbeatLoop();
        startCurrentPageSyncLoop();
        // 页面已刷新并完成首次同步，标记 nonce 为已处理，下次 heartbeat 回报给服务器
        if (pendingSyncNonce) {
            state.lastHandledSyncNowNonce = pendingSyncNonce;
        }
    }
    window.addEventListener('beforeunload', closeBrowserApiSocket);
    if (document.readyState === 'complete') {
        init();
    }
    else {
        window.addEventListener('load', init, { once: true });
    }
})();
