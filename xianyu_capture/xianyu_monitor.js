// ==UserScript==
// @name         闲鱼消息监控与导出 (v3.5)
// @namespace    http://tampermonkey.net/
// @version      3.5
// @description  监控闲鱼网页版消息，修复无商品 ID 副本会话问题，支持自动巡逻与数据持久化，获取userId
// @author       XiaoWai
// @match        https://www.goofish.com/im*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    // --- 用户配置区 (User Configuration) ---
    const CONFIG = {
        userName: "我的头好大",

        // 自动抓取配置
        autoCrawl: true,
        minDelay: 3000,
        maxDelay: 5000,
        maxCrawlLimit: 100,

        panelId: 'xianyu-monitor-panel',
        storageKey: 'xm_chat_history',

        selectors: {
            myMessage: '.message-text-right--Vhy6k0cY',
            theirMessage: '.message-text-left--Wvuv8NsL',
            messageText: '.message-text--zV88pB7N'
        }
    };
    // ------------------------------------

    console.log(`[XM] Script v3.5 initialized.`);

    let savedData = {};
    try {
        const raw = localStorage.getItem(CONFIG.storageKey);
        if (raw) savedData = JSON.parse(raw);
    } catch (e) { }

    const state = {
        chats: savedData,
        currentKey: null,
        scrollPositions: {},
        collapsed: {},
        lastSaveTime: 0,
        isCrawling: CONFIG.autoCrawl,
        visitedThisCycle: new Set(),
        noNewItemsStreak: 0,
        crawledTotal: 0,
        statusText: '初始化...',
        isMinimized: false
    };

    window.xmState = state;

    // Native fetch wrapper (fallback when GM_xmlhttpRequest unavailable or fails)
    function nativeFetch(url, options = {}) {
        return fetch(url, {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body || undefined,
        }).then(r => ({
            ok: r.ok,
            status: r.status,
            json: () => r.json(),
            text: () => r.text()
        }));
    }

    // Tampermonkey HTTP Request Wrapper with timeout and native fetch fallback
    function gmFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'undefined') {
                return nativeFetch(url, options).then(resolve, reject);
            }
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: options.headers || {},
                data: options.body || null,
                timeout: 10000,
                onload: function (response) {
                    resolve({
                        ok: response.status >= 200 && response.status < 300,
                        status: response.status,
                        json: () => Promise.resolve(JSON.parse(response.responseText)),
                        text: () => Promise.resolve(response.responseText)
                    });
                },
                onerror: function (err) {
                    console.warn('[XM] GM_xmlhttpRequest failed, trying native fetch...', url);
                    nativeFetch(url, options).then(resolve, reject);
                },
                ontimeout: function () {
                    console.warn('[XM] GM_xmlhttpRequest timed out, trying native fetch...', url);
                    nativeFetch(url, options).then(resolve, reject);
                }
            });
        });
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
     * @param {{content: string, isMe: boolean}[]} left - 左侧消息列表。
     * @param {{content: string, isMe: boolean}[]} right - 右侧消息列表。
     * @returns {boolean} 是否逐条完全一致。
     */
    function areMessagesEquivalent(left = [], right = []) {
        if (left.length !== right.length) return false;
        for (let i = 0; i < left.length; i++) {
            if ((left[i]?.content || '') !== (right[i]?.content || '')) return false;
            if (!!left[i]?.isMe !== !!right[i]?.isMe) return false;
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
     * @param {{ customerName: string, productId: string|null, product: Record<string, any>, messages: {content: string, isMe: boolean}[] }} incomingChat - 本轮新提取的会话快照。
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
            product: {}
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
            product: mergeProductInfo(incomingChat.product, mergeProductInfo(targetChat.product, sourceChat.product))
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
     * @param {{ customerName: string, productId: string|null, product: Record<string, any>, messages: {content: string, isMe: boolean}[] }} incomingChat - 当前提取结果。
     * @returns {boolean} 是否更新了缓存内容。
     */
    function syncChatState(chatKey, incomingChat) {
        const existingChat = state.chats[chatKey];
        if (!existingChat) {
            state.chats[chatKey] = {
                customerName: incomingChat.customerName,
                productId: incomingChat.productId || null,
                messages: incomingChat.messages || [],
                product: mergeProductInfo(incomingChat.product, {})
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
        if ((incomingChat.messages || []).length > 0 && !areMessagesEquivalent(incomingChat.messages, existingChat.messages || [])) {
            existingChat.messages = incomingChat.messages;
            changed = true;
        }
        return changed;
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
                <span>🐟 监控台 v3.5</span>
            </div>
            <div style="display:flex;gap:8px;">
                <button id="xm-crawl-toggle" style="padding:4px 8px;font-size:12px;cursor:pointer;background:${state.isCrawling ? '#ffaaaa' : '#e0ffe0'};border:none;border-radius:4px;font-weight:bold;">${state.isCrawling ? '⏸ 暂停' : '▶️ 自动'}</button>
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

        header.querySelector('#xm-crawl-toggle').onclick = (e) => {
            state.isCrawling = !state.isCrawling;
            e.target.innerText = state.isCrawling ? '⏸ 暂停' : '▶️ 自动';
            e.target.style.background = state.isCrawling ? '#ffaaaa' : '#e0ffe0';
            state.statusText = state.isCrawling ? '恢复巡逻...' : '已暂停';
            renderFooter();
            if (state.isCrawling) crawlNext();
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
            const allElements = main.querySelectorAll('*');
            const messageNodes = [];
            allElements.forEach(el => {
                if (el.className && typeof el.className === 'string') {
                    if (el.className.includes('message-text-right--') || el.className.includes('message-text-left--')) {
                        messageNodes.push(el);
                    }
                }
            });

            messageNodes.forEach(el => {
                const content = el.innerText.trim();
                if (!content) return;
                const isMe = el.className.includes('message-text-right');
                messages.push({ content: content, isMe: isMe });
            });

            const canonicalChatKey = findCanonicalChatKey(customerName, messages);
            const chatKey = product.id
                ? buildChatKey(customerName, product.id)
                : (canonicalChatKey || buildChatKey(customerName, null));
            state.currentKey = chatKey;

            const incomingChat = {
                customerName,
                productId: product.id || null,
                product,
                messages
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

            if (dataChanged) { saveState(); renderPanel(); }

            // --- Auto-Sender Integration ---
            await checkPendingAndSend(chatKey, product, customerName);

        } catch (e) { console.error('[XM]', e); }
    }

    /**
     * 检查当前会话是否有待发消息，如果匹配则发送。
     * 注意：本函数不管理巡逻循环，发送完成后直接返回，
     * 由调用方（crawlNext 的 setTimeout）继续驱动巡逻。
     */
    async function checkPendingAndSend(currentChatKey, currentProduct, currentCustomerName) {
        if (!state.isCrawling) return;

        try {
            // 1. Fetch pending messages
            const res = await gmFetch('http://127.0.0.1:3210/api/outgoing-messages?status=pending');
            if (!res.ok) {
                console.warn(`[XM Sender] API returned ${res.status}`);
                return;
            }
            const data = await res.json();
            const pendingArr = data ? data.filter(m => m.status === 'pending') : [];
            if (!pendingArr || pendingArr.length === 0) return;

            console.log(`[XM Sender] ${pendingArr.length} pending, current: ${currentChatKey}`);

            // 2. Look for an exact match based on chatKey
            let targetMsg = null;
            for (const msg of pendingArr) {
                const dbChatKey = msg.chat_key || '';
                if (dbChatKey === currentChatKey) {
                    targetMsg = msg;
                    break;
                }
            }

            if (!targetMsg) return;

            state.statusText = `匹配到待发消息, 准备发送...`; renderFooter();
            console.log(`[XM Sender] 匹配! #${targetMsg.id} for ${currentChatKey}`);

            // 3. 暂停巡逻（防止 toggle 按钮等外部触发 crawlNext 干扰发送）
            state.isCrawling = false;

            try {
                const inputSelectors = [
                    'textarea[class*="input"]',
                    'div[contenteditable="true"]',
                    'textarea[placeholder*="输入"]',
                    'textarea[placeholder*="消息"]',
                    '.chat-input textarea',
                    '#message-input',
                    'textarea',
                ];

                let inputEl = null;
                for (const sel of inputSelectors) {
                    inputEl = document.querySelector(sel);
                    if (inputEl) break;
                }

                if (!inputEl) {
                    console.warn(`[XM Sender] cannot find input box for #${targetMsg.id}`);
                    await gmFetch(`http://127.0.0.1:3210/api/outgoing-messages/${targetMsg.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'failed', error: '找不到输入框' })
                    }).catch(e => console.error('[XM Sender] PATCH failed:', e));
                    return;
                }

                // Focus and value setting (simulate React event)
                inputEl.focus();
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(inputEl, targetMsg.content);
                } else {
                    inputEl.value = targetMsg.content;
                }
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));

                await new Promise(r => setTimeout(r, 500));

                const sendBtn = findSendButtonElement();

                if (sendBtn) {
                    sendBtn.click();
                    console.log(`[XM Sender] clicked send button for #${targetMsg.id}`);
                } else {
                    console.warn(`[XM Sender] cannot find send button for #${targetMsg.id}`);
                    await gmFetch(`http://127.0.0.1:3210/api/outgoing-messages/${targetMsg.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'failed', error: '找不到发送按钮' })
                    }).catch(e => console.error('[XM Sender] PATCH failed:', e));
                    return;
                }

                await new Promise(r => setTimeout(r, 1000));

                // Clear input
                if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(inputEl, '');
                } else {
                    inputEl.value = '';
                }
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.blur();

                // 4. Mark as sent
                await gmFetch(`http://127.0.0.1:3210/api/outgoing-messages/${targetMsg.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'sent' })
                });
                console.log(`[XM Sender] #${targetMsg.id} sent and PATCHed.`);
                state.statusText = `消息 #${targetMsg.id} 已发送`; renderFooter();

            } finally {
                // 5. 无论成功失败，恢复巡逻状态，由调用方继续驱动 crawlNext
                state.isCrawling = true;
            }

            // 发送后等待 2 秒再让调用方继续巡逻（避免过快）
            await new Promise(r => setTimeout(r, 2000));

        } catch (err) {
            console.error('[XM Sender] checkPendingAndSend error:', err.message || err);
        }
    }

    function init() {
        console.log('[XM] Starting...');
        const cleanedCount = cleanupAnonymousDuplicateChats();
        if (cleanedCount > 0) {
            console.info(`[XM] cleaned ${cleanedCount} anonymous duplicate chat(s).`);
            saveState();
        }
        createPanel();
        renderPanel();
        if (CONFIG.autoCrawl) setTimeout(crawlNext, 2000);
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();
