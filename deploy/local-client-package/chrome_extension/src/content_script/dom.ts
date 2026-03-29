/**
 * dom.ts
 * DOM 查询与等待工具函数。负责查找页面元素、等待渲染完成、
 * 拉取历史消息等纯 DOM 操作，不包含业务逻辑。
 */

import { CONFIG } from './config';
import { sleep } from './api';

/**
 * 归一化界面文案，去掉空白字符后再做按钮文本匹配。
 * @param text - 原始界面文案。
 * @returns 归一化后的文本。
 */
export function normalizeUiText(text: string): string {
    return String(text || '').replace(/\s+/g, '').trim();
}

/**
 * 判断一个元素是否在页面中真实可见，避免命中隐藏按钮。
 * @param el - 待检测元素。
 * @returns 是否可见。
 */
export function isElementVisible(el: Element | null): boolean {
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
 * 这里会先按可见按钮的归一化文案匹配"发送"，兼容"发 送"这类带空格的按钮文本。
 * @returns 找到的发送按钮。
 */
export function findSendButtonElement(): HTMLElement | null {
    const textMatchedButton = Array.from(document.querySelectorAll('button'))
        .find(button => isElementVisible(button) && normalizeUiText(button.textContent ?? '') === '发送');
    if (textMatchedButton) {
        return textMatchedButton;
    }

    return Array.from(document.querySelectorAll<HTMLElement>('button[class*="send"], .send-btn, [data-testid*="send"]'))
        .find(isElementVisible) ?? null;
}

/**
 * 转义 HTML 特殊字符，用于将纯文本安全地插入 HTML 内容。
 * @param text - 原始文本。
 * @returns 转义后的字符串。
 */
export function escapeHtml(text: string): string {
    return text ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
}

/**
 * 获取左侧会话列表的可滚动容器元素。
 * @returns 容器元素，未找到时返回 null。
 */
export function getSidebarContainer(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.rc-virtual-list-holder')
        || document.querySelector<HTMLElement>('div[class*="virtual-list"]');
}

/**
 * 获取左侧会话列表中所有直接子 DIV 会话项。
 * @returns 会话项元素数组。
 */
export function getSidebarItems(): HTMLElement[] {
    const container = document.querySelector('.rc-virtual-list-holder-inner');
    if (container) {
        return Array.from(container.children).filter((c): c is HTMLElement => c.tagName === 'DIV');
    }
    return [];
}

/**
 * 归一化左侧会话项的文本，尽量去掉时间和未读数这类易变内容。
 * @param text - 左侧会话项原始文本。
 * @returns 归一化后的文本行数组。
 */
export function normalizeSidebarLines(text: string): string[] {
    return (text || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^\d+$/.test(line))
        .filter(line => !/^(刚刚|昨天|前天|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)$/u.test(line));
}

/**
 * 为左侧会话项生成遍历用唯一键，避免同名买家在一轮巡逻中互相覆盖。
 * @param item - 当前左侧会话项节点。
 * @param occurrenceMap - 当前可见区域内的签名计数器。
 * @returns 会话标题与遍历键。
 */
export function getItemIdentifier(
    item: HTMLElement,
    occurrenceMap: Map<string, number>
): { title: string; visitKey: string } {
    const titleEl = item.querySelector<HTMLElement>('.title-box--xH34x78G');
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
 * @returns 当前是否正在输入消息。
 */
export function isUserTypingMessage(): boolean {
    const activeEl = document.activeElement;
    return !!activeEl && (
        activeEl.tagName === 'TEXTAREA'
        || activeEl.getAttribute('contenteditable') === 'true'
    );
}

/**
 * 读取当前右侧会话标题，用于判断 React 是否已经切换到目标会话。
 * @returns 当前右侧会话标题；未命中时返回空串。
 */
export function readCurrentConversationName(): string {
    const main = document.querySelector<HTMLElement>('div[role="main"]') || document.querySelector<HTMLElement>('main');
    if (!main) {
        return '';
    }

    const headerEl = main.querySelector<HTMLElement>('div');
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
 * @param expectedCustomerName - 期望切换到的买家名；为空时只要求会话窗口已可读。
 * @returns 是否在超时前等到目标会话。
 */
export async function waitForConversationRender(expectedCustomerName: string | null = null): Promise<boolean> {
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
 * @returns 是否在超时前等到聊天工作区就绪。
 */
export async function waitForChatWorkspaceReady(): Promise<boolean> {
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
 * @param root - 查询根节点；为空时默认使用当前主会话区。
 * @returns 当前渲染的消息节点。
 */
export function getRenderedMessageNodes(root: ParentNode | null = null): HTMLElement[] {
    const main = root || document.querySelector<HTMLElement>('div[role="main"]') || document.querySelector<HTMLElement>('main');
    if (!main) {
        return [];
    }

    return Array.from((main as HTMLElement).querySelectorAll<HTMLElement>(CONFIG.selectors.messageNode));
}

/**
 * 查找当前右侧消息区的可滚动容器，用于向上翻到顶部拉取历史消息。
 * @returns 消息滚动容器。
 */
export function findConversationHistoryScroller(): HTMLElement | null {
    const messageNode = getRenderedMessageNodes()[0];
    if (!messageNode) {
        return null;
    }

    let current: HTMLElement | null = messageNode.parentElement;
    while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const canScroll = current.scrollHeight > current.clientHeight + 20;
        const overflowY = style.overflowY || '';
        if (canScroll && /(auto|scroll)/i.test(overflowY)) {
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
 */
export async function loadFullConversationHistory(): Promise<void> {
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
 * 查找当前聊天窗口的输入框元素。
 * @returns 可输入的消息框。
 */
export function findMessageInputElement(): HTMLTextAreaElement | HTMLElement | null {
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
        const inputEl = document.querySelector<HTMLElement>(selector);
        if (inputEl) {
            return inputEl;
        }
    }
    return null;
}

/**
 * 查找页面现有的图片上传 input。
 * @returns 上传 input；未找到时返回 null。
 */
export function findImageUploadInputElement(): HTMLInputElement | null {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    return inputs.find(input => {
        const accept = input.getAttribute('accept') || '';
        return !accept || accept.includes('image');
    }) ?? null;
}

/**
 * 查找页面里的图片上传触发器。
 * @returns 触发上传选择的按钮或容器。
 */
export function findImageUploadTriggerElement(): HTMLElement | null {
    const selectors = [
        '[class*="upload-icon--"]',
        '.ant-upload-select',
        '.ant-upload',
        '[data-testid*="upload"]',
        '[aria-label*="图片"]',
        '[aria-label*="上传"]'
    ];

    for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element) {
            return element;
        }
    }

    return null;
}

