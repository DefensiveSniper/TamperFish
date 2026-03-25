/**
 * crawler.ts — 会话巡逻与提取逻辑
 *
 * 包含左侧列表巡逻循环、未读监听循环、活跃会话轻量同步循环，
 * 以及从右侧会话详情提取消息快照的核心函数 extractData。
 *
 * 注意：本文件运行在 world: "MAIN" 环境，不可使用任何 chrome.* API。
 */

import { CONFIG } from './config';
import { state, scheduleStateSave, schedulePanelRender } from './state';
import { sleep, browserApiRequest } from './api';
import {
    buildChatKey,
    syncChatState,
    captureConversationFromListItem,
    getUnreadBadgeElement,
    findCanonicalChatKey,
    mergeDuplicateChatState,
    areMessagesEquivalent
} from './sync';
import {
    buildVisibleConversationEntries,
    extractMessageTransportMetaFromNode,
    getCurrentActiveSessionId
} from './fiber';
import {
    getSidebarItems,
    getSidebarContainer,
    getItemIdentifier,
    getRenderedMessageNodes,
    isUserTypingMessage,
    readCurrentConversationName
} from './dom';
import { renderFooter, setCrawlingEnabled, persistCrawlerDesiredState } from './panel';
import { startSerialLoop } from './utils';

let activeConversationMutationObserver: MutationObserver | null = null;
let activeConversationMutationTimer: number | null = null;

/**
 * 判断图片 URL 是否仍然指向远端资源，适合改写为本地缓存地址。
 * @param url - 原始图片 URL。
 * @returns 是否需要本地化。
 */
function shouldLocalizeImageUrl(url: string): boolean {
    return /^https?:\/\/img\.alicdn\.com\//i.test(String(url || '').trim());
}

/**
 * 批量把图片消息的远端 URL 改写为本地服务缓存地址，降低页面直接访问阿里图片的暴露面。
 * @param messages - 当前提取出的消息数组。
 */
async function localizeImageMessageUrls(messages: Array<{
    content: string;
    type?: 'text' | 'image';
}>): Promise<void> {
    const remoteUrls = Array.from(new Set(
        messages
            .filter(message => message.type === 'image' && shouldLocalizeImageUrl(message.content))
            .map(message => message.content)
    ));

    if (!remoteUrls.length) {
        return;
    }

    try {
        const payload = await browserApiRequest('media.cache', { urls: remoteUrls }, {
            timeoutMs: 30000,
        }) as { urls?: Record<string, string> };

        const localizedUrlMap = payload?.urls || {};
        messages.forEach((message) => {
            if (message.type !== 'image') {
                return;
            }

            const localizedUrl = localizedUrlMap[message.content];
            if (localizedUrl) {
                message.content = localizedUrl;
            }
        });
    } catch (error) {
        console.warn(
            '[XM] localize image urls failed:',
            error instanceof Error ? error.message : error
        );
    }
}

/**
 * 基于消息气泡在聊天主区域中的横向位置判断消息归属。
 * 优先使用实际布局位置，而不是依赖易变的类名语义。
 * @param messageEl - 单条消息行节点。
 * @param bubbleEl - 文本或图片气泡节点。
 * @param mainEl - 当前聊天主区域节点。
 * @returns 是否为当前账号发送的消息；无法判断时返回 null。
 */
function detectMessageOwnershipByLayout(
    messageEl: HTMLElement,
    bubbleEl: HTMLElement,
    mainEl: HTMLElement
): boolean | null {
    const bubbleRect = bubbleEl.getBoundingClientRect();
    const messageRect = messageEl.getBoundingClientRect();
    const mainRect = mainEl.getBoundingClientRect();

    if (bubbleRect.width <= 0 || messageRect.width <= 0 || mainRect.width <= 0) {
        return null;
    }

    const bubbleCenterX = bubbleRect.left + bubbleRect.width / 2;
    const mainCenterX = mainRect.left + mainRect.width / 2;
    const minGap = Math.min(24, mainRect.width * 0.08);

    if (bubbleCenterX >= mainCenterX + minGap) {
        return true;
    }

    if (bubbleCenterX <= mainCenterX - minGap) {
        return false;
    }

    const computedStyle = window.getComputedStyle(messageEl);
    if (computedStyle.justifyContent === 'flex-end') {
        return true;
    }
    if (computedStyle.justifyContent === 'flex-start') {
        return false;
    }

    return null;
}

// ---------------------------------------------------------------------------
// 未读条目构建
// ---------------------------------------------------------------------------

/**
 * 收集当前左侧列表中所有带未读角标的会话项元数据。
 * @returns 未读条目数组，每项包含 DOM 元素、标题、遍历键与去重键。
 */
export function buildVisibleUnreadEntries(): Array<{
    itemEl: HTMLElement;
    title: string;
    visitKey: string;
    unreadKey: string;
}> {
    const unreadEntries: Array<{
        itemEl: HTMLElement;
        title: string;
        visitKey: string;
        unreadKey: string;
    }> = [];
    const occurrenceMap = new Map<string, number>();

    for (const itemEl of getSidebarItems()) {
        if (!getUnreadBadgeElement(itemEl)) {
            continue;
        }

        const meta = getItemIdentifier(itemEl, occurrenceMap);
        // 提取 sessionInfo 用于获取 sessionId 作为 unreadKey（比 visitKey 更稳定）
        // 避免重复导入 extractSessionInfoFromConversationItem，直接从 fiber 层取 sessionId
        // 通过 buildVisibleConversationEntries 已经维护了 state.sessionIndex，
        // 但这里只需要侧边栏标准元数据，故用 visitKey 兜底
        const sessionEntry = buildVisibleConversationEntries().find(
            e => e.itemEl === itemEl
        );
        unreadEntries.push({
            itemEl,
            title: meta.title,
            visitKey: meta.visitKey,
            unreadKey: sessionEntry?.sessionId || meta.visitKey
        });
    }

    return unreadEntries;
}

// ---------------------------------------------------------------------------
// 初始化同步
// ---------------------------------------------------------------------------

/**
 * 项目启动时做一轮限量初始化，把前 N 个会话的历史记录尽快拉回本地缓存与数据库。
 * 初始化完成后自动关闭常驻巡逻，但保留遍历能力作为精准发送 fallback。
 * @param syncNonce - 初始化指令唯一标识，用于防止重复执行。
 * @param sessionCount - 最多同步的会话数，缺省时使用 CONFIG.initialConversationSyncLimit。
 */
export async function runInitialConversationSync(
    syncNonce: string,
    sessionCount?: number
): Promise<void> {
    if (state.initializationBusy) {
        return;
    }
    if (!syncNonce) {
        return;
    }
    if (
        syncNonce === state.lastHandledInitialCrawlNonce
        || syncNonce === state.activeInitialCrawlNonce
    ) {
        return;
    }

    const limit = sessionCount || CONFIG.initialConversationSyncLimit;

    const workspaceReady = await (async () => {
        const deadline = Date.now() + CONFIG.startupReadyTimeoutMs;
        while (Date.now() < deadline) {
            const main =
                document.querySelector('div[role="main"]')
                || document.querySelector('main');
            const sidebar = getSidebarContainer();
            if (main && sidebar) return true;
            await sleep(300);
        }
        return false;
    })();

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

    const visited = new Set<string>();
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

            let targetItem: HTMLElement | null = null;
            let targetMeta: { title: string; visitKey: string } | null = null;
            const occurrenceMap = new Map<string, number>();
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
        console.error(
            '[XM] initial conversation sync failed:',
            error instanceof Error ? error.message : error
        );
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

// ---------------------------------------------------------------------------
// 未读监听循环
// ---------------------------------------------------------------------------

/**
 * 关闭自动巡逻后，仅根据左侧未读角标做增量抓取。
 * 这不会重跑全量遍历，只处理有未读提示的会话。
 */
export async function runUnreadWatchOnce(): Promise<void> {
    if (
        state.unreadWatchBusy
        || state.initializationBusy
        || state.senderBusy
        || state.isCrawling
    ) {
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
        console.warn(
            '[XM] unread watch failed:',
            error instanceof Error ? error.message : error
        );
    } finally {
        state.unreadWatchBusy = false;
    }
}

/**
 * 启动未读会话监听循环。
 * 初始化完成后，自动巡逻关闭，但这条循环会持续根据未读角标同步新消息。
 */
export function startUnreadWatchLoop(): void {
    startSerialLoop(runUnreadWatchOnce, CONFIG.unreadWatchIntervalMs);
}

// ---------------------------------------------------------------------------
// 巡逻循环
// ---------------------------------------------------------------------------

/**
 * 按"当前可见项中第一个未访问会话"的策略驱动左侧列表巡逻。
 * crawlNext 以 setTimeout 递归驱动，自身完成（或跳过）后安排下一次调度。
 */
export function crawlNext(): void {
    if (!state.isCrawling) return;
    const activeEl = document.activeElement;
    if (
        activeEl
        && (
            activeEl.tagName === 'TEXTAREA'
            || activeEl.getAttribute('contenteditable') === 'true'
        )
    ) {
        state.statusText = '检测到输入，暂停...';
        renderFooter();
        setTimeout(crawlNext, 2000);
        return;
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
        state.statusText = '未找到列表';
        renderFooter();
        setTimeout(crawlNext, 2000);
        return;
    }

    buildVisibleConversationEntries();

    // 找当前可见项中第一个未访问的
    let targetItem: HTMLElement | null = null;
    let targetMeta: { title: string; visitKey: string } | null = null;
    const occurrenceMap = new Map<string, number>();
    for (const item of items) {
        const meta = getItemIdentifier(item, occurrenceMap);
        if (meta.visitKey && !state.visitedThisCycle.has(meta.visitKey)) {
            targetItem = item;
            targetMeta = meta;
            break;
        }
    }

    if (targetItem && targetMeta) {
        // 找到未访问的会话
        state.noNewItemsStreak = 0;
        state.visitedThisCycle.add(targetMeta.visitKey);
        state.crawledTotal++;
        state.statusText = `抓取: ${state.crawledTotal} (本轮已访 ${state.visitedThisCycle.size})`;
        renderFooter();

        targetItem.click();
        if (targetItem.firstElementChild) {
            (targetItem.firstElementChild as HTMLElement).click();
        }

        const delay =
            Math.floor(Math.random() * (CONFIG.maxDelay - CONFIG.minDelay + 1))
            + CONFIG.minDelay;
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
        if (!container) {
            setTimeout(crawlNext, 2000);
            return;
        }

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
                state.statusText = '长期无新会话，重置本轮...';
                renderFooter();
                state.visitedThisCycle.clear();
                state.noNewItemsStreak = 0;
                container.scrollTop = 0;
                setTimeout(crawlNext, 3000);
                return;
            }
            state.statusText = '翻页中...';
            renderFooter();
            container.scrollTop += container.clientHeight;
            setTimeout(crawlNext, 2000);
        }
    }
}

// ---------------------------------------------------------------------------
// 核心提取逻辑
// ---------------------------------------------------------------------------

/**
 * 提取当前右侧会话详情，并在必要时将其写入本地缓存与后端。
 * @param expectedSession - 左侧点击时记录的预期会话信息，用于检测 React 渲染滞后。
 */
export async function extractData(
    expectedSession?: { customerName?: string; visitKey?: string } | null
): Promise<void> {
    try {
        const main =
            document.querySelector<HTMLElement>('div[role="main"]')
            || document.querySelector<HTMLElement>('main');
        if (!main) return;
        let dataChanged = false;
        const visibleEntries = buildVisibleConversationEntries();
        const activeEntry = visibleEntries.find(entry => entry.isActive) || null;

        let customerName = activeEntry?.title?.trim() || '';
        if (
            !customerName
            || customerName === '消息'
            || customerName === 'Unknown'
        ) {
            customerName = readCurrentConversationName();
        }
        if (
            customerName === 'Unknown'
            || customerName === '尚未选择任何联系人'
            || customerName === '通知消息'
        ) {
            return;
        }

        // CRUCIAL: Verify that React has finished rendering the new chat window by comparing names
        if (
            expectedSession?.customerName
            && customerName !== expectedSession.customerName
        ) {
            console.warn(
                `[XM] React render lag detected! Left panel: ${expectedSession.customerName}, Right: ${customerName}. Skipping extraction.`
            );
            return;
        }

        let product: {
            price: string;
            location: string;
            url: string;
            id: string | null;
            userId: string | null;
        } = { price: '', location: '', url: '', id: null, userId: null };

        const productLink = main.querySelector<HTMLAnchorElement>('a[href*="/item?id="]');
        if (productLink) {
            const container = productLink.closest('div');
            const text = container ? (container as HTMLElement).innerText : '';
            const priceMatch = text.match(/¥\d+(\.\d+)?/);
            product = {
                price: priceMatch ? priceMatch[0] : '',
                location: text.includes('·')
                    ? (text.split('\n').find(l => l.includes('·')) ?? '')
                    : '',
                url: productLink.href,
                id: productLink.href.match(/id=(\d+)/)?.[1] ?? null,
                userId: null
            };
        }

        // 提取买家 userId：右上角"闲鱼号"按钮所在容器 .right-container--AxSGn7lz 内的 a[href*="userId="]
        try {
            const rightBox = main.querySelector('.right-container--AxSGn7lz');
            const userLink = rightBox
                ? rightBox.querySelector<HTMLAnchorElement>('a[href*="userId="]')
                : null;
            if (userLink?.href) {
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
            const divs = Array.from(main.querySelectorAll<HTMLElement>('div'));
            const priceDiv = divs.find(d =>
                d.innerText.includes('¥')
                && d.innerText.length < 50
                && (d.innerText.includes('含运费') || d.innerText.includes('立即购买'))
            );
            if (priceDiv) {
                const priceMatch = priceDiv.innerText.match(/¥\d+(\.\d+)?/);
                product.price = priceMatch ? priceMatch[0] : '';
                product.location =
                    priceDiv.innerText.split('\n').find(l => l.includes('·')) || '';
            }
        }

        const messages: Array<{
            content: string;
            isMe: boolean;
            type: 'text' | 'image';
            messageId?: string | null;
            replyMessageId?: string | null;
        }> = [];
        const messageNodes = getRenderedMessageNodes(main);

        messageNodes.forEach(el => {
            const transportMeta = extractMessageTransportMetaFromNode(el);
            const imgContainer = el.querySelector(CONFIG.selectors.imageContainer);
            if (imgContainer) {
                // 图片消息：优先取 ant-image-img（原图URL），其次取容器内第一个 img
                const origImg = imgContainer.querySelector<HTMLImageElement>('.ant-image-img');
                const fallbackImg = imgContainer.querySelector<HTMLImageElement>('img');
                const imgSrc =
                    (origImg && origImg.src)
                    || (fallbackImg && fallbackImg.src)
                    || '';
                if (!imgSrc) return;
                const isMe = detectMessageOwnershipByLayout(el, imgContainer, main) ?? false;
                messages.push({
                    content: imgSrc,
                    isMe,
                    type: 'image',
                    messageId: transportMeta?.messageId,
                    replyMessageId: transportMeta?.replyMessageId
                });
                return;
            }
            const textNode = el.querySelector<HTMLElement>('[class*="message-text--"]');
            if (textNode) {
                const content = textNode.innerText.trim();
                if (!content) return;
                const isMe =
                    detectMessageOwnershipByLayout(el, textNode, main)
                    ?? textNode.matches(CONFIG.selectors.myMessage);
                messages.push({
                    content,
                    isMe,
                    type: 'text',
                    messageId: transportMeta?.messageId,
                    replyMessageId: transportMeta?.replyMessageId
                });
            }
        });

        await localizeImageMessageUrls(messages);

        const canonicalChatKey = findCanonicalChatKey(customerName, messages);
        const chatKey = product.id
            ? buildChatKey(customerName, product.id)
            : (canonicalChatKey || buildChatKey(customerName, null));
        const buyerUserId =
            activeEntry?.sessionInfo?.userInfo?.userId
            || product.userId
            || null;
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
        if (
            product.id
            && anonymousChatKey !== chatKey
            && state.chats[anonymousChatKey]
            && areMessagesEquivalent(
                state.chats[anonymousChatKey].messages || [],
                messages
            )
        ) {
            if (mergeDuplicateChatState(anonymousChatKey, chatKey, incomingChat)) {
                console.info(
                    `[XM] merged anonymous duplicate chat ${anonymousChatKey} -> ${chatKey}`
                );
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
    } catch (e) {
        console.error('[XM]', e);
    }
}

// ---------------------------------------------------------------------------
// 活跃会话轻量同步循环
// ---------------------------------------------------------------------------

/**
 * 判断当前是否存在可供轻量同步的活跃会话，避免在空白页上空转。
 * @returns 当前是否检测到活跃会话。
 */
export function hasActiveConversation(): boolean {
    if (getCurrentActiveSessionId()) {
        return true;
    }

    const main =
        document.querySelector<HTMLElement>('div[role="main"]')
        || document.querySelector<HTMLElement>('main');
    if (!main) {
        return false;
    }

    const mainText = (main.innerText || '').trim();
    return !!mainText && !/尚未选择任何联系人|通知消息/u.test(mainText);
}

/**
 * 在关闭巡逻时继续同步当前打开会话，避免消息记录只能依赖遍历补拉。
 * 该逻辑不会切换会话，只会读取当前右侧聊天窗口。
 */
export async function runActiveConversationSyncOnce(): Promise<void> {
    if (
        state.activeSyncBusy
        || state.senderBusy
        || state.initializationBusy
        || state.unreadWatchBusy
    ) {
        return;
    }
    if (!hasActiveConversation()) {
        return;
    }

    state.activeSyncBusy = true;
    try {
        await extractData(null);
    } catch (error) {
        console.warn(
            '[XM] active conversation sync failed:',
            error instanceof Error ? error.message : error
        );
    } finally {
        state.activeSyncBusy = false;
    }
}

/**
 * 启动当前会话轻量同步循环。
 * 关闭巡逻后，这条循环继续工作，用来持续同步当前打开会话的消息变化。
 */
export function startActiveConversationSyncLoop(): void {
    runActiveConversationSyncOnce();
    startSerialLoop(runActiveConversationSyncOnce, CONFIG.activeSyncIntervalMs, {
        immediate: false
    });

    if (activeConversationMutationObserver) {
        activeConversationMutationObserver.disconnect();
    }

    const main =
        document.querySelector<HTMLElement>('div[role="main"]')
        || document.querySelector<HTMLElement>('main');
    if (!main) {
        return;
    }

    activeConversationMutationObserver = new MutationObserver(() => {
        if (
            state.activeSyncBusy
            || state.senderBusy
            || state.initializationBusy
            || state.unreadWatchBusy
            || isUserTypingMessage()
        ) {
            return;
        }

        if (activeConversationMutationTimer !== null) {
            clearTimeout(activeConversationMutationTimer);
        }

        activeConversationMutationTimer = window.setTimeout(() => {
            activeConversationMutationTimer = null;
            runActiveConversationSyncOnce().catch((error) => {
                console.warn(
                    '[XM] active conversation mutation sync failed:',
                    error instanceof Error ? error.message : error
                );
            });
        }, 300);
    });

    activeConversationMutationObserver.observe(main, {
        childList: true,
        subtree: true,
        characterData: true
    });
}
