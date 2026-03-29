/**
 * sync.ts
 * 会话状态同步与合并逻辑。
 * 负责将从 DOM 提取的聊天快照写回 state.chats，并处理无 ID 副本合并、
 * 完整历史拉取等业务流程。
 */

import { CONFIG } from './config';
import { state } from './state';
import { sleep } from './api';
import { waitForConversationRender, loadFullConversationHistory } from './dom';
import { extractData } from './crawler';
import type { Message, ProductInfo, ChatRecord, SessionInfo, ConversationEntry } from './types';

const EMPTY_PRODUCT_INFO: ProductInfo = {
    price: '',
    location: '',
    url: '',
    id: null,
    userId: null
};

/**
 * 基于买家名与商品 ID 生成稳定的 chatKey。
 * @param customerName - 买家名。
 * @param productId - 商品 ID。
 * @returns 归一化后的会话键。
 */
export function buildChatKey(customerName: string, productId?: string | null): string {
    return customerName + (productId ? `_${productId}` : '');
}

/**
 * 判断两组消息是否为同一条会话快照。
 * @param left - 左侧消息数组。
 * @param right - 右侧消息数组。
 * @returns 是否逐条完全一致。
 */
export function areMessagesEquivalent(left: Message[] = [], right: Message[] = []): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if ((left[i]?.content || '') !== (right[i]?.content || '')) return false;
        if (!!left[i]?.isMe !== !!right[i]?.isMe) return false;
        if ((left[i]?.type || 'text') !== (right[i]?.type || 'text')) return false;
        if ((left[i]?.messageId || '') !== (right[i]?.messageId || '')) return false;
        if ((left[i]?.replyMessageId || '') !== (right[i]?.replyMessageId || '')) return false;
    }
    return true;
}

/**
 * 合并两份商品信息，优先保留更完整的字段。
 * @param preferred - 当前新提取到的商品信息。
 * @param fallback - 历史缓存中的商品信息。
 * @returns 合并后的商品对象。
 */
export function mergeProductInfo(
    preferred: ProductInfo = EMPTY_PRODUCT_INFO,
    fallback: ProductInfo = EMPTY_PRODUCT_INFO
): ProductInfo {
    return {
        price: preferred.price || fallback.price || '',
        location: preferred.location || fallback.location || '',
        url: preferred.url || fallback.url || '',
        id: preferred.id || fallback.id || null,
        userId: preferred.userId || fallback.userId || null
    };
}

/**
 * 根据消息快照查找同买家下的完整会话键，用于把"无 ID 副本"并回真实会话。
 * @param customerName - 当前买家名。
 * @param messages - 当前右侧提取到的消息快照。
 * @returns 匹配到的完整会话键；未命中则返回 null。
 */
export function findCanonicalChatKey(customerName: string, messages: Message[]): string | null {
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
 * @param sourceKey - 待删除的副本键。
 * @param targetKey - 最终保留的真实会话键。
 * @param incomingChat - 本轮新提取的会话快照。
 * @returns 是否发生了合并。
 */
export function mergeDuplicateChatState(
    sourceKey: string,
    targetKey: string,
    incomingChat: ChatRecord
): boolean {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return false;
    const sourceChat = state.chats[sourceKey];
    if (!sourceChat) return false;

    const targetChat: ChatRecord = state.chats[targetKey] || {
        customerName: incomingChat.customerName,
        productId: incomingChat.productId || null,
        messages: [],
        product: {},
        buyerUserId: incomingChat.buyerUserId || null,
        sessionId: incomingChat.sessionId || null,
        sessionInfo: incomingChat.sessionInfo || null
    };

    const sourceMessages: Message[] = sourceChat.messages || [];
    const targetMessages: Message[] = targetChat.messages || [];
    const mergedMessages: Message[] =
        incomingChat.messages.length >= targetMessages.length
            ? incomingChat.messages
            : (targetMessages.length >= sourceMessages.length ? targetMessages : sourceMessages);

    state.chats[targetKey] = {
        customerName:
            incomingChat.customerName
            || targetChat.customerName
            || sourceChat.customerName
            || targetKey.split('_')[0],
        productId:
            incomingChat.productId
            || targetChat.productId
            || sourceChat.productId
            || null,
        messages: mergedMessages,
        product: mergeProductInfo(
            incomingChat.product,
            mergeProductInfo(targetChat.product, sourceChat.product)
        ),
        buyerUserId:
            incomingChat.buyerUserId
            || targetChat.buyerUserId
            || sourceChat.buyerUserId
            || null,
        sessionId:
            incomingChat.sessionId
            || targetChat.sessionId
            || sourceChat.sessionId
            || null,
        sessionInfo:
            incomingChat.sessionInfo
            || targetChat.sessionInfo
            || sourceChat.sessionInfo
            || null
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
 * @returns 被合并删除的副本数量。
 */
export function cleanupAnonymousDuplicateChats(): number {
    let cleaned = 0;
    for (const [chatKey, chat] of Object.entries({ ...state.chats })) {
        if (!chat || chatKey.includes('_') || chat.productId) continue;
        const customerName = chat.customerName || chatKey;
        const canonicalKey = findCanonicalChatKey(customerName, chat.messages || []);
        if (!canonicalKey) continue;
        if (
            mergeDuplicateChatState(chatKey, canonicalKey, {
                customerName,
                productId: state.chats[canonicalKey]?.productId || null,
                buyerUserId: state.chats[canonicalKey]?.buyerUserId || chat.buyerUserId || null,
                product: mergeProductInfo(
                    state.chats[canonicalKey]?.product || {},
                    chat.product || {}
                ),
                messages: chat.messages || [],
                sessionId: null,
                sessionInfo: null
            })
        ) {
            cleaned++;
        }
    }
    return cleaned;
}

/**
 * 将当前提取结果写回到指定会话键，并返回是否有实际变化。
 * @param chatKey - 目标会话键。
 * @param incomingChat - 当前提取结果。
 * @returns 是否更新了缓存内容。
 */
export function syncChatState(chatKey: string, incomingChat: ChatRecord): boolean {
    const existingChat = state.chats[chatKey];
    if (!existingChat) {
        state.chats[chatKey] = {
            customerName: incomingChat.customerName,
            productId: incomingChat.productId || null,
            messages: incomingChat.messages || [],
            product: mergeProductInfo(incomingChat.product, EMPTY_PRODUCT_INFO),
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
    if (
        (incomingChat.messages || []).length > 0
        && !areMessagesEquivalent(incomingChat.messages, existingChat.messages || [])
    ) {
        existingChat.messages = incomingChat.messages;
        changed = true;
    }
    return changed;
}

/**
 * 打开指定左侧会话项，并执行一次提取；可选地先补拉该会话的全部历史。
 * @param itemEl - 左侧会话项节点。
 * @param options - 会话采集选项。
 * @returns 是否成功完成本次采集。
 */
export async function captureConversationFromListItem(
    itemEl: HTMLElement,
    options: { expectedCustomerName?: string | null; pullFullHistory?: boolean } = {}
): Promise<boolean> {
    const {
        expectedCustomerName = null,
        pullFullHistory = false
    } = options;

    if (!itemEl || !itemEl.isConnected) {
        return false;
    }

    itemEl.click();
    if (itemEl.firstElementChild) {
        (itemEl.firstElementChild as HTMLElement).click();
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
 * @param itemEl - 左侧会话项节点。
 * @returns 未读角标元素；未命中则返回 null。
 */
export function getUnreadBadgeElement(itemEl: HTMLElement): HTMLElement | null {
    return (
        itemEl.querySelector<HTMLElement>('sup.ant-scroll-number.ant-badge-count')
        || itemEl.querySelector<HTMLElement>('sup.ant-badge-count')
        || itemEl.querySelector<HTMLElement>('[class*="ant-badge-count"]')
    );
}

// 显式导出类型以供其他模块引用（避免 noUnusedLocals 警告）
export type { SessionInfo, ConversationEntry };
