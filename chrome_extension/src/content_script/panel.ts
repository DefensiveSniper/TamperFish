/**
 * panel.ts — 内嵌浮窗监控面板
 *
 * 对应 content_script.js 第 687-930 行。
 * 包含面板创建、巡逻开关渲染、状态切换与持久化，以及完整的消息列表渲染逻辑。
 *
 * 注意：本文件运行在 world: "MAIN" 环境，不可使用任何 chrome.* API。
 */

import { CONFIG } from './config';
import { state } from './state';
import { browserApiRequest } from './api';
import { escapeHtml } from './dom';
import type { ChatRecord } from './types';

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQuotedPrefixPattern(parts: Array<string | null | undefined>): RegExp | null {
    const normalizedParts = parts
        .map((part) => part?.trim() ?? '')
        .filter(Boolean);

    if (normalizedParts.length === 0) {
        return null;
    }

    const separatorPattern = '[\\s\\n\\r:：>】）)】\\-]+';
    const pattern = normalizedParts
        .map((part) => escapeRegex(part).replace(/\s+/g, '\\s+'))
        .join(separatorPattern);

    return new RegExp(`^\\s*${pattern}[\\s\\n\\r:：>】）)】\\-]*`, 'u');
}

function renderPanelMessagePreview(content: string, type?: 'text' | 'image'): string {
    if (type === 'image') {
        return `<img src="${escapeHtml(content)}" alt="图片" style="display:block;max-width:180px;max-height:180px;border-radius:10px;cursor:pointer;" />`;
    }

    return escapeHtml(content);
}

function stripQuotedReplyPrefix(
    content: string,
    type: 'text' | 'image' | undefined,
    repliedMessage?: { content: string; type?: 'text' | 'image' } | null,
    repliedAuthorLabel?: string | null
): string {
    const normalizedContent = String(content || '').trim();
    if (!normalizedContent || type !== 'text' || !repliedMessage || repliedMessage.type === 'image') {
        return normalizedContent;
    }

    const quotedText = String(repliedMessage.content || '').trim();
    if (!quotedText) {
        return normalizedContent;
    }

    if (normalizedContent === quotedText) {
        return '';
    }

    const prefixPatterns = [
        buildQuotedPrefixPattern([repliedAuthorLabel, quotedText]),
        buildQuotedPrefixPattern([quotedText])
    ].filter((pattern): pattern is RegExp => pattern instanceof RegExp);

    for (const prefixPattern of prefixPatterns) {
        const matchedPrefix = normalizedContent.match(prefixPattern);
        if (matchedPrefix) {
            const remainder = normalizedContent.slice(matchedPrefix[0].length).trim();
            return remainder || normalizedContent;
        }
    }

    const normalizedAuthor = repliedAuthorLabel?.trim();
    const combinedPrefix = normalizedAuthor ? `${normalizedAuthor}\n${quotedText}` : '';

    if (combinedPrefix && normalizedContent.startsWith(combinedPrefix)) {
        const remainder = normalizedContent
            .slice(combinedPrefix.length)
            .replace(/^[\s\n\r:：>】）)】\-]+/, '')
            .trim();

        return remainder || normalizedContent;
    }

    if (!normalizedContent.startsWith(quotedText)) {
        return normalizedContent;
    }

    const remainder = normalizedContent
        .slice(quotedText.length)
        .replace(/^[\s\n\r:：>】）)】\-]+/, '')
        .trim();

    return remainder || normalizedContent;
}

function renderQuotedPreview(chat: ChatRecord, replyMessageId?: string | null): string {
    if (!replyMessageId) {
        return '';
    }

    const repliedMessage = chat.messages.find((message) => message.messageId === replyMessageId);
    if (!repliedMessage) {
        return '<div style="margin-bottom:6px;padding:2px 0 2px 10px;border-left:3px solid #ffda44;border-radius:2px;color:#666;font-size:12px;"><div style="font-size:11px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#c28a00;margin-bottom:4px;">引用消息</div><div style="color:#8098bf;">原消息暂不可用</div></div>';
    }

    const authorLabel = repliedMessage.isMe ? '我' : (chat.customerName || '对方');

    const previewContent = repliedMessage.type === 'image'
        ? `<div style="padding-top:2px;"><div style="display:flex;align-items:center;gap:8px;"><img src="${escapeHtml(repliedMessage.content)}" alt="引用图片" style="display:block;width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;" /><span style="color:#8098bf;font-size:12px;line-height:1.3;">图片引用</span></div></div>`
        : escapeHtml(
            repliedMessage.content.length > 48
                ? `${repliedMessage.content.slice(0, 48)}...`
                : repliedMessage.content
        );

    const wrappedTextContent = repliedMessage.type === 'image'
        ? previewContent
        : `<div style="color:#8098bf;">${previewContent}</div>`;

    return `<div style="margin-bottom:6px;padding:2px 0 2px 10px;border-left:3px solid #ffda44;border-radius:2px;color:#666;font-size:12px;"><div style="font-size:11px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#c28a00;margin-bottom:4px;">引用 <span style="color:#8fb3ff;">${escapeHtml(authorLabel)}</span> 的${repliedMessage.type === 'image' ? '图片' : '消息'}</div>${wrappedTextContent}</div>`;
}

// ---------------------------------------------------------------------------
// 脚本版本（与 content_script.js SCRIPT_VERSION 保持一致）
// ---------------------------------------------------------------------------

const SCRIPT_VERSION = '4.3';

// ---------------------------------------------------------------------------
// 巡逻开关
// ---------------------------------------------------------------------------

/**
 * 渲染油猴面板中的巡逻按钮文案和颜色。
 * 这里展示的是"期望状态"，而不是发送期的瞬时暂停状态。
 */
function renderCrawlToggleButton(): void {
    const toggleBtn = document.getElementById('xm-crawl-toggle');
    if (!toggleBtn) return;
    toggleBtn.innerText = state.crawlingDesiredEnabled ? '⏸ 暂停' : '▶️ 自动';
    toggleBtn.style.background = state.crawlingDesiredEnabled ? '#ffaaaa' : '#e0ffe0';
}

/**
 * 将巡逻开关、远程同步和临时挂起统一收敛到一个状态机。
 * @param nextValue - 目标状态；临时挂起模式下表示是否解除挂起。
 * @param reason - 触发本次状态变化的原因。
 * @param options - 状态机配置。
 */
export function setCrawlingEnabled(
    nextValue: boolean,
    reason: string,
    options: { transient?: boolean } = {}
): void {
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
        // 动态导入 crawlNext，避免循环依赖（crawler.ts → panel.ts → crawler.ts）
        // 使用延迟调用确保模块已加载
        void import('./crawler').then(({ crawlNext }) => crawlNext());
    }
}

/**
 * 将本地巡逻期望状态同步到后端设置表，供 3210 UI 远程展示与控制。
 * @param nextValue - 期望的新状态。
 * @returns Promise<void>
 */
export async function persistCrawlerDesiredState(nextValue: boolean): Promise<void> {
    try {
        await browserApiRequest('settings.patch', {
            crawlerDesiredEnabled: nextValue,
        });
    } catch (error) {
        const err = error as Error;
        console.warn('[XM] persist crawler desired state failed:', err.message || error);
    }
}

// ---------------------------------------------------------------------------
// 面板创建
// ---------------------------------------------------------------------------

/**
 * 在页面 body 中创建内嵌浮窗监控面板并绑定所有交互事件。
 * 若面板已存在则直接返回，保证幂等。
 */
export function createPanel(): void {
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

    const crawlToggleBtn = header.querySelector<HTMLButtonElement>('#xm-crawl-toggle');
    if (crawlToggleBtn) {
        crawlToggleBtn.onclick = async () => {
            const nextValue = !state.crawlingDesiredEnabled;
            setCrawlingEnabled(nextValue, 'panel-click');
            await persistCrawlerDesiredState(nextValue);
        };
    }

    const clearBtn = header.querySelector<HTMLButtonElement>('#xm-clear');
    if (clearBtn) {
        clearBtn.onclick = () => {
            state.chats = {};
            state.visitedThisCycle.clear();
            state.noNewItemsStreak = 0;
            localStorage.removeItem(CONFIG.storageKey);
            renderPanel();
        };
    }

    const minBtn = header.querySelector<HTMLButtonElement>('#xm-min');
    const toggleBtn = header.querySelector<HTMLButtonElement>('#xm-crawl-toggle');
    renderCrawlToggleButton();

    if (minBtn) {
        minBtn.onclick = () => {
            state.isMinimized = !state.isMinimized;
            if (state.isMinimized) {
                panel.style.height = '50px';
                panel.style.width = '200px';
                content.style.display = 'none';
                footer.style.display = 'none';
                minBtn.innerText = '□';
                if (toggleBtn) toggleBtn.style.display = 'none';
            } else {
                panel.style.height = '90vh';
                panel.style.width = '360px';
                content.style.display = 'block';
                footer.style.display = 'block';
                minBtn.innerText = '_';
                if (toggleBtn) toggleBtn.style.display = 'inline-block';
            }
        };
    }

    content.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('xm-collapse-btn') || target.closest('.xm-collapse-btn')) {
            const btn = target.classList.contains('xm-collapse-btn')
                ? target
                : (target.closest('.xm-collapse-btn') as HTMLElement);
            const key = (btn as HTMLElement & { dataset: DOMStringMap }).dataset['key'];
            if (key) {
                state.collapsed[key] = !state.collapsed[key];
                renderPanel();
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 面板渲染
// ---------------------------------------------------------------------------

/**
 * 完整重渲染内嵌浮窗监控面板的消息列表区域。
 *
 * 保留主滚动位置和各会话消息框的滚动位置，避免重渲染时页面跳动。
 * 由 state.ts 的 schedulePanelRender 通过回调机制触发。
 */
export function renderPanel(): void {
    const content = document.getElementById('xm-content');
    if (!content) return;

    // 保存当前滚动位置
    const mainScrollTop = content.scrollTop;
    const chatBoxes = content.querySelectorAll<HTMLElement>('.xm-chat-box-messages');
    chatBoxes.forEach((box) => {
        const key = box.getAttribute('data-key');
        if (key) state.scrollPositions[key] = box.scrollTop;
    });

    const chatKeys = Object.keys(state.chats).filter(
        (k) =>
            k !== 'Unknown' &&
            k !== '通知消息' &&
            state.chats[k].messages.length > 0
    );

    if (chatKeys.length === 0) {
        content.innerHTML =
            '<div style="text-align:center;color:#999;margin-top:40px;">暂无聊天记录</div>';
    } else {
        content.innerHTML = '';

        chatKeys.forEach((key) => {
            const chat: ChatRecord = state.chats[key];
            const isCurrent = state.currentKey === key;
            const isCollapsed = state.collapsed[key] !== false;

            const chatBox = document.createElement('div');
            chatBox.style.cssText = `
                background: white; margin-bottom: 12px; border-radius: 8px;
                box-shadow: 0 2px 6px rgba(0,0,0,0.04); overflow: hidden;
                border: 2px solid ${isCurrent ? '#ffda44' : 'transparent'};
            `;

            let productHtml = '';
            if (
                !isCollapsed &&
                chat.product &&
                (chat.product.price || chat.product.location)
            ) {
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

            const displayName =
                chat.customerName || key.split('_')[0] || 'Unknown';

            let messagesHtml = '';
            if (!isCollapsed) {
                messagesHtml = `
                    <div class="xm-chat-box-messages" data-key="${key}" style="padding:12px;max-height:300px;overflow-y:auto;background:#fafafa;">
                        ${
                            chat.messages
                                .map(
                                    (m) => {
                            const repliedMessage = m.replyMessageId
                                ? chat.messages.find((message) => message.messageId === m.replyMessageId) || null
                                : null;
                            const repliedAuthorLabel = repliedMessage
                                ? (repliedMessage.isMe ? '我' : displayName)
                                : null;
                            const displayContent = stripQuotedReplyPrefix(m.content, m.type, repliedMessage, repliedAuthorLabel);

                            return `
                            <div style="margin-bottom: 8px; display: flex; flex-direction: column; align-items: ${m.isMe ? 'flex-end' : 'flex-start'};">
                                <div style="font-size:10px;color:${m.isMe ? '#c28a00' : '#7f9bc2'};font-weight:600;margin-bottom:3px;margin-${m.isMe ? 'right' : 'left'}:4px;">${m.isMe ? '我' : displayName}</div>
                                <div style="
                                    max-width: 85%; padding: 8px 12px; border-radius: 12px;
                                    background: ${m.isMe ? '#ffda44' : '#fff'};
                                    color: ${m.isMe ? '#000' : '#333'};
                                    font-size: 13px; line-height: 1.4;
                                    border: ${m.isMe ? 'none' : '1px solid #e0e0e0'};
                                    word-wrap: break-word; white-space: pre-wrap;
                                    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
                                ">${renderQuotedPreview(chat, m.replyMessageId)}${renderPanelMessagePreview(displayContent || m.content, m.type)}</div>
                            </div>
                        `;
                        }
                                )
                                .join('') ||
                            '<div style="text-align:center;color:#ddd;padding:10px;">暂无消息</div>'
                        }
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

        // 恢复滚动位置
        content.scrollTop = mainScrollTop;
        const newChatBoxes = content.querySelectorAll<HTMLElement>('.xm-chat-box-messages');
        newChatBoxes.forEach((box) => {
            const key = box.getAttribute('data-key');
            if (key && state.scrollPositions[key] !== undefined) {
                box.scrollTop = state.scrollPositions[key];
            }
        });
    }

    renderFooter();
}

// ---------------------------------------------------------------------------
// 页脚渲染
// ---------------------------------------------------------------------------

/**
 * 更新面板底部状态栏文字。
 */
export function renderFooter(): void {
    const footer = document.getElementById('xm-footer');
    if (footer) {
        footer.innerText = `${state.statusText} | 会话: ${Object.keys(state.chats).length}`;
    }
}
