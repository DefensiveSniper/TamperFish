/**
 * fiber.ts
 * 通过遍历 React Fiber 树提取会话元数据。
 * content script 运行在 world: "MAIN"，可直接访问页面的 React 内部属性。
 */

import { getSidebarItems } from './dom';
import type { SessionInfo, ConversationEntry } from './types';
import { state } from './state';

interface MessageTransportMeta {
    messageId: string | null;
    replyMessageId: string | null;
}

interface SearchCandidate {
    value: unknown;
    depth: number;
}

const MESSAGE_OBJECT_SEARCH_DEPTH = 6;
const MESSAGE_OBJECT_SEARCH_LIMIT = 160;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

function parseExtJsonRecord(value: unknown): Record<string, unknown> | null {
    if (!value) {
        return null;
    }

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value) as Record<string, unknown>;
            return isPlainRecord(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    return isPlainRecord(value) ? value : null;
}

function getMessageObjectCandidates(record: Record<string, unknown>): unknown[] {
    const pendingProps = isPlainRecord(record.pendingProps) ? record.pendingProps : null;
    const memoizedProps = isPlainRecord(record.memoizedProps) ? record.memoizedProps : null;
    const props = isPlainRecord(record.props) ? record.props : null;

    return [
        record.message,
        record.msg,
        record.item,
        record.data,
        record.model,
        record.record,
        record.payload,
        pendingProps?.message,
        pendingProps?.msg,
        pendingProps?.item,
        pendingProps?.data,
        pendingProps?.model,
        pendingProps?.record,
        memoizedProps?.message,
        memoizedProps?.msg,
        memoizedProps?.item,
        memoizedProps?.data,
        memoizedProps?.model,
        memoizedProps?.record,
        props?.message,
        props?.msg,
        props?.item,
        props?.data,
        props?.model,
        props?.record
    ];
}

function scoreMessageLikeRecord(record: Record<string, unknown>): number {
    let score = 0;
    if (record.messageId != null) score += 5;
    if (record.replyMessageId != null) score += 4;
    if (record.extJson != null) score += 3;
    if (record.sessionId != null) score += 2;
    if (record.senderInfo != null) score += 1;
    if (record.content != null) score += 1;
    return score;
}

/**
 * 将页面内部消息对象裁剪为发送链路真正需要的最小字段。
 * @param value - React props/fiber 中可能出现的消息对象。
 * @returns 提炼后的消息标识；未命中时返回 null。
 */
function normalizeMessageTransportMeta(value: unknown): MessageTransportMeta | null {
    if (!isPlainRecord(value)) {
        return null;
    }

    const record = value;
    let rawMessageId = record.messageId;
    let rawReplyMessageId = record.replyMessageId;
    const extJsonRecord = parseExtJsonRecord(record.extJson)
        ?? parseExtJsonRecord(isPlainRecord(record.extension) ? record.extension.extJson : null)
        ?? parseExtJsonRecord(isPlainRecord(record.ext) ? record.ext.extJson : null);

    if (rawMessageId == null || rawReplyMessageId == null) {
        rawMessageId ??= extJsonRecord?.messageId;
        rawReplyMessageId ??= extJsonRecord?.replyMessageId;
    }

    if (rawMessageId == null && rawReplyMessageId == null) {
        return null;
    }

    return {
        messageId: rawMessageId == null ? null : String(rawMessageId),
        replyMessageId: rawReplyMessageId == null ? null : String(rawReplyMessageId)
    };
}

function collectReactContainerCandidates(messageEl: HTMLElement): unknown[] {
    const candidates: unknown[] = [];
    const visitedElements = new Set<HTMLElement>();
    const pendingElements: HTMLElement[] = [messageEl];

    let currentParent: HTMLElement | null = messageEl.parentElement;
    for (let depth = 0; currentParent && depth < 4; depth++) {
        pendingElements.push(currentParent);
        currentParent = currentParent.parentElement;
    }

    const childElements = Array.from(messageEl.querySelectorAll<HTMLElement>('*')).slice(0, 24);
    pendingElements.push(...childElements);

    for (const element of pendingElements) {
        if (!element || visitedElements.has(element)) {
            continue;
        }
        visitedElements.add(element);

        const elementAsRecord = element as unknown as Record<string, unknown>;
        Object.keys(elementAsRecord).forEach((key) => {
            if (key.startsWith('__reactFiber') || key.startsWith('__reactProps')) {
                candidates.push(elementAsRecord[key]);
            }
        });
    }

    return candidates;
}

function findMessageTransportMetaInObjectGraph(root: unknown): MessageTransportMeta | null {
    const queue: SearchCandidate[] = [{ value: root, depth: 0 }];
    const seen = new Set<object>();
    let scanned = 0;

    while (queue.length > 0 && scanned < MESSAGE_OBJECT_SEARCH_LIMIT) {
        const current = queue.shift();
        if (!current || !isPlainRecord(current.value)) {
            continue;
        }

        const record = current.value;
        if (seen.has(record)) {
            continue;
        }
        seen.add(record);
        scanned += 1;

        if (scoreMessageLikeRecord(record) > 0) {
            const matched = normalizeMessageTransportMeta(record);
            if (matched) {
                return matched;
            }
        }

        for (const candidate of getMessageObjectCandidates(record)) {
            if (!isPlainRecord(candidate)) {
                continue;
            }
            if (seen.has(candidate)) {
                continue;
            }
            const matched = normalizeMessageTransportMeta(candidate);
            if (matched) {
                return matched;
            }
            if (current.depth + 1 <= MESSAGE_OBJECT_SEARCH_DEPTH) {
                queue.unshift({ value: candidate, depth: current.depth + 1 });
            }
        }

        if (current.depth + 1 > MESSAGE_OBJECT_SEARCH_DEPTH) {
            continue;
        }

        for (const key of Object.keys(record)) {
            const nestedValue = record[key];
            if (!isPlainRecord(nestedValue)) {
                continue;
            }

            if ((nestedValue as Record<string, unknown>).nodeType || (nestedValue as Record<string, unknown>).ownerDocument) {
                continue;
            }

            queue.push({ value: nestedValue, depth: current.depth + 1 });
        }
    }

    return null;
}

/**
 * 从 React 会话对象中提取可序列化的最小路由信息，避免把整棵 React 树写入本地缓存。
 * @param sessionInfo - 原始会话对象（来自 React Fiber，类型未知）。
 * @returns 精简后的会话信息；无效时返回 null。
 */
export function normalizeSessionInfo(sessionInfo: unknown): SessionInfo | null {
    if (
        !sessionInfo
        || typeof sessionInfo !== 'object'
        || !('sessionId' in sessionInfo)
        || !(sessionInfo as Record<string, unknown>).sessionId
    ) {
        return null;
    }

    const s = sessionInfo as Record<string, unknown>;

    // itemInfo 字段
    let itemInfo: SessionInfo['itemInfo'] = null;
    if (s.itemInfo && typeof s.itemInfo === 'object') {
        const ii = s.itemInfo as Record<string, unknown>;
        let sellerInfo: { userId: string } | null = null;
        if (ii.sellerInfo && typeof ii.sellerInfo === 'object') {
            const si = ii.sellerInfo as Record<string, unknown>;
            sellerInfo = {
                userId: si.userId != null ? String(si.userId) : ''
            };
        }
        itemInfo = {
            itemId: ii.itemId != null ? String(ii.itemId) : '',
            title: typeof ii.title === 'string' ? ii.title : '',
            sellerInfo
        };
    }

    // ownerInfo 字段
    let ownerInfo: { userId: string } | null = null;
    if (s.ownerInfo && typeof s.ownerInfo === 'object') {
        const oi = s.ownerInfo as Record<string, unknown>;
        ownerInfo = {
            userId: oi.userId != null ? String(oi.userId) : ''
        };
    }

    // userInfo 字段
    let userInfo: { userId: string; nick: string; fishNick: string } | null = null;
    if (s.userInfo && typeof s.userInfo === 'object') {
        const ui = s.userInfo as Record<string, unknown>;
        userInfo = {
            userId: ui.userId != null ? String(ui.userId) : '',
            nick: typeof ui.nick === 'string' ? ui.nick : '',
            fishNick: typeof ui.fishNick === 'string' ? ui.fishNick : ''
        };
    }

    // summary 字段
    let summary: SessionInfo['summary'] = null;
    if (s.summary && typeof s.summary === 'object') {
        const sm = s.summary as Record<string, unknown>;
        let latestMessage: { messageId: string; sessionId: string } | null = null;
        if (sm.latestMessage && typeof sm.latestMessage === 'object') {
            const lm = sm.latestMessage as Record<string, unknown>;
            latestMessage = {
                messageId: typeof lm.messageId === 'string' ? lm.messageId : '',
                sessionId: lm.sessionId != null ? String(lm.sessionId) : ''
            };
        }
        summary = { latestMessage };
    }

    return {
        sessionId: String(s.sessionId),
        sessionType: typeof s.sessionType === 'string' ? s.sessionType : null,
        targetUrlSessionInfo: (s.targetUrlSessionInfo as SessionInfo['targetUrlSessionInfo']) || null,
        itemInfo,
        ownerInfo,
        userInfo,
        summary
    };
}

/**
 * 递归扫描会话项的 React 树，提取其中的 sessionInfo。
 * @param itemEl - 左侧会话项 DOM。
 * @returns 归一化后的会话信息；未命中时返回 null。
 */
export function extractSessionInfoFromConversationItem(itemEl: HTMLElement | null): SessionInfo | null {
    if (!itemEl) return null;

    const candidates: unknown[] = [];
    // __reactFiber* 和 __reactProps* 是 React 注入的动态属性名，
    // 需要通过 Record<string, unknown> 访问
    const elementAsRecord = itemEl as unknown as Record<string, unknown>;
    Object.keys(elementAsRecord).forEach((key) => {
        if (key.startsWith('__reactFiber') || key.startsWith('__reactProps')) {
            candidates.push(elementAsRecord[key]);
        }
    });

    const seen = new Set<object>();
    while (candidates.length > 0) {
        const current = candidates.shift();
        if (!current || typeof current !== 'object' || seen.has(current as object)) {
            continue;
        }
        seen.add(current as object);

        const cur = current as Record<string, unknown>;
        const maybeSessionInfo =
            cur.sessionInfo
            ?? (cur.pendingProps as Record<string, unknown> | undefined)?.sessionInfo
            ?? (cur.memoizedProps as Record<string, unknown> | undefined)?.sessionInfo;
        const normalized = normalizeSessionInfo(maybeSessionInfo);
        if (normalized) {
            return normalized;
        }

        for (const key of Object.keys(cur).slice(0, 30)) {
            const value = cur[key];
            if (!value || typeof value !== 'object') continue;
            const v = value as Record<string, unknown>;
            if (v.nodeType || v.ownerDocument) continue;
            candidates.push(value);
        }
    }

    return null;
}

/**
 * 从单条消息节点关联的 React Fiber/Props 中提取页面原生消息 ID。
 * @param messageEl - 右侧消息列表中的单条消息节点。
 * @returns 消息标识；未命中时返回 null。
 */
export function extractMessageTransportMetaFromNode(
    messageEl: HTMLElement | null
): MessageTransportMeta | null {
    if (!messageEl) {
        return null;
    }

    const candidates: unknown[] = collectReactContainerCandidates(messageEl);

    const seen = new Set<object>();
    while (candidates.length > 0) {
        const current = candidates.shift();
        if (!current || typeof current !== 'object' || seen.has(current as object)) {
            continue;
        }
        seen.add(current as object);

        const cur = current as Record<string, unknown>;
        const directMatch = findMessageTransportMetaInObjectGraph(current);
        if (directMatch) {
            return directMatch;
        }

        for (const key of Object.keys(cur)) {
            const value = cur[key];
            if (!value || typeof value !== 'object') {
                continue;
            }
            const record = value as Record<string, unknown>;
            if (record.nodeType || record.ownerDocument) {
                continue;
            }
            candidates.push(value);
        }
    }

    return null;
}

/**
 * 扫描当前可见会话列表，建立基于 session_id 的会话索引。
 * @returns 当前可见会话元数据数组。
 */
export function buildVisibleConversationEntries(): ConversationEntry[] {
    const entries: ConversationEntry[] = [];
    for (const itemEl of getSidebarItems()) {
        const sessionInfo = extractSessionInfoFromConversationItem(itemEl);
        if (!sessionInfo?.sessionId) continue;

        const title = (itemEl.innerText || '').split('\n')[0].trim();
        const productId = sessionInfo.itemInfo?.itemId ? String(sessionInfo.itemInfo.itemId) : '';
        const entry: ConversationEntry = {
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
 * @returns 当前激活的会话 ID；未命中时返回 null。
 */
export function getCurrentActiveSessionId(): string | null {
    const activeItem = getSidebarItems().find(item => item.className.includes('conversation-item-active'));
    const activeSessionInfo = extractSessionInfoFromConversationItem(activeItem ?? null);
    return activeSessionInfo?.sessionId || state.currentSessionId || null;
}
