/**
 * sender.ts — 精准发送逻辑
 *
 * 包含通过 claim/patch 接口与服务端交互、定位目标会话、
 * 向输入框写入消息并点击发送按钮的完整发送链路。
 *
 * 注意：本文件运行在 world: "MAIN" 环境，不可使用任何 chrome.* API。
 */

import { CONFIG } from './config';
import { state, schedulePanelRender } from './state';
import { sleep, browserApiRequest } from './api';
import { buildVisibleConversationEntries, getCurrentActiveSessionId } from './fiber';
import {
    getSidebarContainer,
    findSendButtonElement,
    findMessageInputElement,
    findImageUploadInputElement,
    findImageUploadTriggerElement
} from './dom';
import { extractData } from './crawler';
import { renderFooter, setCrawlingEnabled } from './panel';
import type {
    ConversationEntry,
    OutgoingMessage,
    OutgoingClaimResponse
} from './types';

interface WebpackRequireLike {
    c?: Record<string, { exports: unknown }>;
}

interface PageSendHelpers {
    sendText: (
        sessionId: string,
        content: string,
        replyMessageId?: string,
        extJson?: Record<string, unknown>
    ) => Promise<unknown>;
    sendImage: (
        sessionId: string,
        file: File
    ) => Promise<unknown>;
}

let cachedPageSendHelpers: PageSendHelpers | null | undefined;

// ---------------------------------------------------------------------------
// 会话匹配
// ---------------------------------------------------------------------------

/**
 * 判断当前可见会话项是否匹配待发任务。
 * @param entry - 当前可见会话项。
 * @param task - 待发任务。
 * @returns 是否命中该会话。
 */
export function doesConversationMatchTask(
    entry: ConversationEntry,
    task: OutgoingMessage
): boolean {
    const cachedChat = task.chat_key ? state.chats[task.chat_key] : null;
    const taskSessionId = task.session_id || cachedChat?.sessionId || '';
    const taskProductId = String(
        task.product_id || cachedChat?.productId || ''
    ).trim();
    const taskCustomerName =
        task.customer_name
        || cachedChat?.customerName
        || (task.chat_key || '').split('_')[0];
    // chat_key 前缀独立提取，作兜底：customer_name 可能误存了卖家名（如与买家重名场景），
    // 此时直接用 chat_key 第一段匹配，避免找不到目标会话。
    const chatKeyPrefix = (task.chat_key || '').split('_')[0];

    // session_id 是会话级唯一标识，优先精确匹配。
    // 有 session_id 时不走 title 模糊匹配，避免同名买家/售后交易关闭场景下误投。
    if (taskSessionId) {
        return entry.sessionId === String(taskSessionId);
    }

    // 无 session_id（极少数历史数据）才退化为 title 模糊匹配。
    const titleMatches =
        (!!taskCustomerName && entry.title === taskCustomerName)
        || (!!chatKeyPrefix && chatKeyPrefix !== taskCustomerName && entry.title === chatKeyPrefix);

    if (taskProductId) {
        return titleMatches && entry.productId === taskProductId;
    }
    return titleMatches;
}

// ---------------------------------------------------------------------------
// 会话激活
// ---------------------------------------------------------------------------

/**
 * 等待指定 session_id 成为当前激活会话。
 * @param targetSessionId - 目标会话 ID；为空时只要求当前有激活会话即可。
 * @returns 是否在超时前成功激活。
 */
export async function waitForSessionActivation(
    targetSessionId?: string | null
): Promise<boolean> {
    const deadline = Date.now() + CONFIG.targetOpenTimeoutMs;
    while (Date.now() < deadline) {
        const activeSessionId = getCurrentActiveSessionId();
        if (
            !targetSessionId
            || (activeSessionId && String(activeSessionId) === String(targetSessionId))
        ) {
            return true;
        }
        await sleep(250);
    }
    return false;
}

/**
 * 打开指定会话项，并等待它成为当前激活会话。
 * @param entry - 目标会话项（DOM 元素 + sessionId）。
 * @returns 是否成功打开。
 */
export async function activateConversationEntry(
    entry: { itemEl: HTMLElement; sessionId: string }
): Promise<boolean> {
    if (!entry?.itemEl || !entry.itemEl.isConnected) {
        return false;
    }
    entry.itemEl.click();
    if (entry.itemEl.firstElementChild) {
        (entry.itemEl.firstElementChild as HTMLElement).click();
    }
    return waitForSessionActivation(entry.sessionId || null);
}

// ---------------------------------------------------------------------------
// 会话定位
// ---------------------------------------------------------------------------

/**
 * 在当前可见会话列表中直接命中目标任务。
 *
 * 匹配优先级：
 *   1. session_id 精确匹配（最高置信度，适用于售后/交易关闭等 product_id 缺失场景）
 *   2. title + product_id 联合匹配（session_id 不可用时的回退）
 *   3. title 单独匹配（仅当结果唯一且候选条目的 sessionId 与 taskSessionId 不冲突时才采用）
 *
 * 当存在多个同名候选且无法通过 session_id / product_id 消歧时，返回 null，
 * 宁可让发送失败也不发到错误会话。
 *
 * @param task - 待发任务。
 * @returns 命中的可见会话项；未命中或有歧义则返回 null。
 */
export function findVisibleConversationForTask(
    task: OutgoingMessage
): ConversationEntry | null {
    const visibleEntries = buildVisibleConversationEntries();
    const cachedChat = task.chat_key ? state.chats[task.chat_key] : null;
    const taskSessionId = task.session_id || cachedChat?.sessionId || '';

    // 1. session_id 精确匹配——最可靠，交易关闭后 sessionId 仍存在于 fiber
    if (taskSessionId) {
        const exact = visibleEntries.find(e => e.sessionId === String(taskSessionId));
        if (exact) return exact;
    }

    // 2. title / product_id 模糊匹配（session_id 未命中时）
    const candidates = visibleEntries.filter(e => doesConversationMatchTask(e, task));

    if (candidates.length === 0) return null;

    if (candidates.length === 1) {
        const sole = candidates[0];
        // 若 task 有明确 session_id，但候选条目持有不同的 sessionId，
        // 说明这是另一个会话命中了 title——拒绝，避免发错人。
        if (taskSessionId && sole.sessionId && sole.sessionId !== String(taskSessionId)) {
            return null;
        }
        return sole;
    }

    // 3. 多个候选：尝试用 product_id 消歧
    const taskProductId = String(task.product_id || cachedChat?.productId || '').trim();
    if (taskProductId) {
        const byProduct = candidates.find(e => e.productId === taskProductId);
        if (byProduct) return byProduct;
    }

    // 真正歧义：同名买家多个会话，无法确定目标，拒绝猜测
    return null;
}

/**
 * 在后台巡逻之外执行一次限次补水，尝试把目标会话滚动到可见区域。
 * @param task - 待发任务。
 * @returns 命中的会话项；失败时返回 null。
 */
export async function locateConversationWithFallback(
    task: OutgoingMessage
): Promise<ConversationEntry | null> {
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

// ---------------------------------------------------------------------------
// 外发消息 API
// ---------------------------------------------------------------------------

/**
 * 通过 claim 接口原子领取一条待发消息。
 * @returns 当前领取到的任务；没有任务时返回 null。
 */
export async function claimOutgoingMessageTask(): Promise<OutgoingMessage | null> {
    const payload = await browserApiRequest('outgoing.claim', {});
    return (payload as OutgoingClaimResponse)?.message || null;
}

/**
 * 回写待发消息状态。
 * @param id - 待发消息主键。
 * @param status - 回写状态。
 * @param error - 失败原因。
 */
export async function patchOutgoingMessageStatus(
    id: number,
    status: 'sent' | 'failed',
    error: string | null = null
): Promise<void> {
    await browserApiRequest('outgoing.patch', {
        id,
        status,
        error
    } as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 消息发送
// ---------------------------------------------------------------------------

/**
 * 将文本写入输入框并点击发送按钮。
 * @param content - 待发送内容。
 */
export async function sendMessageContent(content: string): Promise<void> {
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
        (inputEl as unknown as HTMLInputElement).value = content;
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
        (inputEl as unknown as HTMLInputElement).value = '';
    } else {
        inputEl.textContent = '';
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.blur();
}

/**
 * 通过页面 Webpack runtime 抓取内部 require，复用闲鱼原生发送能力。
 * @returns 页面 require；未命中时返回 null。
 */
function getPageWebpackRequire(): WebpackRequireLike | null {
    const windowRecord = window as unknown as Record<string, unknown>;
    for (const key of Object.keys(windowRecord)) {
        if (!key.startsWith('webpackChunk')) {
            continue;
        }

        const chunkArray = windowRecord[key];
        if (!Array.isArray(chunkArray) || typeof chunkArray.push !== 'function') {
            continue;
        }

        let capturedRequire: WebpackRequireLike | null = null;
        try {
            (chunkArray as Array<unknown>).push([
                [`xm_sender_${Date.now()}`],
                {},
                (webpackRequire: WebpackRequireLike) => {
                    capturedRequire = webpackRequire;
                }
            ]);
        } catch (_) {
            continue;
        }

        if (capturedRequire?.c) {
            return capturedRequire;
        }
    }

    return null;
}

/**
 * 扫描页面已加载模块，定位闲鱼消息发送 helper。
 * @returns 可直接发送文本/图片的 helper；未命中时返回 null。
 */
function getPageSendHelpers(): PageSendHelpers | null {
    if (cachedPageSendHelpers !== undefined) {
        return cachedPageSendHelpers;
    }

    const webpackRequire = getPageWebpackRequire();
    if (!webpackRequire?.c) {
        cachedPageSendHelpers = null;
        return cachedPageSendHelpers;
    }

    const isSendHelpers = (value: unknown): value is PageSendHelpers => {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Record<string, unknown>;
        return typeof candidate.sendText === 'function'
            && typeof candidate.sendImage === 'function';
    };

    for (const moduleRecord of Object.values(webpackRequire.c)) {
        const exported = moduleRecord?.exports;
        const candidates = [exported];
        if (exported && typeof exported === 'object') {
            candidates.push(...Object.values(exported as Record<string, unknown>));
        }

        for (const candidate of candidates) {
            if (isSendHelpers(candidate)) {
                cachedPageSendHelpers = candidate;
                return cachedPageSendHelpers;
            }
        }
    }

    cachedPageSendHelpers = null;
    return cachedPageSendHelpers;
}

/**
 * 根据 data URL 构造页面原生发送 API 需要的 File 对象。
 * @param dataUrl - 前端上传后传来的 base64 data URL。
 * @param preferredName - 用户侧保留的原始文件名。
 * @returns 可直接传给 sendImage 的 File。
 */
function dataUrlToFile(dataUrl: string, preferredName?: string | null): File {
    const matched = dataUrl.match(/^data:(.*?);base64,(.*)$/);
    if (!matched) {
        throw new Error('图片数据格式不合法');
    }

    const [, mimeType, base64Data] = matched;
    const binary = window.atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }

    const extension = mimeType.split('/')[1] || 'png';
    const fileName = preferredName || `xm-image-${Date.now()}.${extension}`;
    return new File([bytes], fileName, { type: mimeType });
}

/**
 * 模拟真实用户行为发送图片：点击上传图标 → 注入文件 → 等待预览 → 点击发送。
 * 作为主路径使用，避免直接调用页面内部 API 被闲鱼反自动化检测。
 * @param mediaData - 图片 data URL。
 * @param mediaName - 图片文件名。
 */
async function sendImageViaDomSimulation(
    mediaData: string,
    mediaName?: string | null
): Promise<void> {
    // 步骤 1：点击图片上传图标，触发文件选择区域
    const uploadTrigger = findImageUploadTriggerElement();
    if (uploadTrigger) {
        uploadTrigger.click();
        await sleep(500);
    }

    // 步骤 2：查找文件上传 input 并注入图片
    let uploadInput = findImageUploadInputElement();
    if (!uploadInput) {
        await sleep(500);
        uploadInput = findImageUploadInputElement();
    }
    if (!uploadInput) {
        throw new Error('当前页面未找到图片上传入口');
    }

    const imageFile = dataUrlToFile(mediaData, mediaName);
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(imageFile);
    uploadInput.files = dataTransfer.files;

    // 模拟用户选择文件后的事件序列
    uploadInput.dispatchEvent(new Event('input', { bubbles: true }));
    uploadInput.dispatchEvent(new Event('change', { bubbles: true }));

    // 步骤 3：等待图片预览渲染
    await sleep(2000);

    // 步骤 4：查找并点击发送按钮（若页面未自动发送）
    const sendBtn = findSendButtonElement();
    if (sendBtn) {
        sendBtn.click();
        await sleep(1000);
    }
}

/**
 * 调用页面内部的文本发送 helper；若带 replyMessageId，则走原生引用回复。
 * @param sessionId - 目标会话 ID。
 * @param content - 待发送文本。
 * @param replyMessageId - 引用回复的目标消息 ID。
 */
async function sendTextViaPageHelpers(
    sessionId: string,
    content: string,
    replyMessageId?: string | null,
    extJson?: Record<string, unknown>
): Promise<void> {
    const helpers = getPageSendHelpers();
    if (!helpers) {
        throw new Error('当前页面未暴露文本发送能力');
    }

    await helpers.sendText(sessionId, content, replyMessageId || undefined, extJson);
    await sleep(1000);
}

/**
 * 调用页面内部的图片发送 helper。
 * @param sessionId - 目标会话 ID。
 * @param mediaData - 图片 data URL。
 * @param mediaName - 图片文件名。
 */
async function sendImageViaPageHelpers(
    sessionId: string,
    mediaData: string,
    mediaName?: string | null
): Promise<void> {
    const helpers = getPageSendHelpers();
    if (!helpers) {
        throw new Error('当前页面未暴露图片发送能力');
    }

    const imageFile = dataUrlToFile(mediaData, mediaName);
    await helpers.sendImage(sessionId, imageFile);
    await sleep(1500);
}

/**
 * 根据任务类型选择合适的发送通道。
 * 文本仍保留 DOM fallback；图片与引用回复优先复用页面原生 helper。
 * @param task - 当前领取到的外发任务。
 */
async function dispatchOutgoingTask(task: OutgoingMessage): Promise<void> {
    const activeSessionId = getCurrentActiveSessionId() || task.session_id || '';
    const messageType = task.message_type || 'text';
    const replyMessageId = task.reply_to_external_message_id || null;

    if (messageType === 'image') {
        if (!task.media_data) {
            throw new Error('图片任务缺少媒体数据');
        }
        try {
            // 主路径：模拟用户操作（点击上传 → 选文件 → 点发送），降低被检测风险
            await sendImageViaDomSimulation(task.media_data, task.media_name);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('未找到图片上传入口')) {
                throw error;
            }
            // 回退：DOM 入口不可用时调用页面内部 API
            if (!activeSessionId) {
                throw new Error('当前会话缺少 session_id，无法发送图片');
            }
            await sendImageViaPageHelpers(activeSessionId, task.media_data, task.media_name);
        }
        return;
    }

    if (replyMessageId) {
        if (!activeSessionId) {
            throw new Error('当前会话缺少 session_id，无法发送引用回复');
        }
        await sendTextViaPageHelpers(activeSessionId, task.content || '', replyMessageId, {});
        return;
    }

    await sendMessageContent(task.content || '');
}

/**
 * 在发送动作完成后重新抓取当前会话，确保新发出的消息能及时写回本地缓存并被 sync.js 上报。
 */
export async function syncConversationAfterSend(): Promise<void> {
    await sleep(1200);
    await extractData(null);
}

// ---------------------------------------------------------------------------
// 会话准备
// ---------------------------------------------------------------------------

/**
 * 为当前待发任务定位目标会话并切换到该会话。
 * @param task - 待发任务。
 * @returns 是否成功定位并激活目标会话。
 */
export async function prepareConversationForTask(
    task: OutgoingMessage
): Promise<boolean> {
    const currentActiveSessionId = getCurrentActiveSessionId();
    if (
        task.session_id
        && currentActiveSessionId
        && String(currentActiveSessionId) === String(task.session_id)
    ) {
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

// ---------------------------------------------------------------------------
// 发送循环
// ---------------------------------------------------------------------------

/**
 * 执行一次精准发送轮询，优先 claim 任务并主动定位目标会话。
 */
export async function runSenderOnce(): Promise<void> {
    if (state.senderBusy) return;
    state.senderBusy = true;

    let claimedTask: OutgoingMessage | null = null;
    try {
        claimedTask = await claimOutgoingMessageTask();
        if (!claimedTask) {
            return;
        }

        const cachedChat = claimedTask.chat_key
            ? state.chats[claimedTask.chat_key]
            : null;
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

        claimedTask.session_id = getCurrentActiveSessionId() || claimedTask.session_id;
        await dispatchOutgoingTask(claimedTask);
        await syncConversationAfterSend();
        await patchOutgoingMessageStatus(claimedTask.id, 'sent');
        state.statusText = `消息 #${claimedTask.id} 已发送`;
        renderFooter();
        schedulePanelRender();
    } catch (error) {
        console.error(
            '[XM Sender] runSenderOnce failed:',
            error instanceof Error ? error.message : error
        );
        if (claimedTask?.id) {
            try {
                await patchOutgoingMessageStatus(
                    claimedTask.id,
                    'failed',
                    error instanceof Error ? error.message : '发送失败'
                );
            } catch (patchError) {
                console.error(
                    '[XM Sender] fail patch failed:',
                    patchError instanceof Error ? patchError.message : patchError
                );
            }
        }
        state.statusText = `精准发送失败: ${error instanceof Error ? error.message : error}`;
        renderFooter();
    } finally {
        setCrawlingEnabled(true, 'sender-loop', { transient: true });
        state.senderBusy = false;
    }
}

/**
 * 启动精准发送轮询，不依赖后台巡逻开关。
 */
export function startSenderLoop(): void {
    const loop = async (): Promise<void> => {
        await runSenderOnce();
        setTimeout(loop, CONFIG.senderPollIntervalMs);
    };
    loop();
}

