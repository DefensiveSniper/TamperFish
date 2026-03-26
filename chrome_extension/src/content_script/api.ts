/**
 * api.ts — Browser API WebSocket RPC 层
 *
 * 封装 content script 到本地 Node 服务的单条 WSS 长连接及所有 RPC 调用。
 * 对应源文件 content_script.js 第 100-288 行。
 *
 * 注意：本文件运行在 world: "MAIN" 环境，不可使用任何 chrome.* API。
 */

import { CONFIG } from './config';
import { browserApiState } from './state';
import type { RpcRequest, RpcResponse } from './types';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 提供统一延时，供定位、发送和心跳轮询复用。
 * @param ms - 等待毫秒数。
 * @returns 延时 Promise。
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 挂起请求管理
// ---------------------------------------------------------------------------

/**
 * 拒绝当前所有挂起的 WSS RPC 请求，避免连接断开后 Promise 永远悬挂。
 * @param reason - 当前批量失败的原因。
 */
export function rejectPendingBrowserApiRequests(reason: string): void {
    for (const [requestId, pending] of browserApiState.pendingRequests.entries()) {
        clearTimeout(pending.timerId);
        pending.reject(new Error(reason || `browser api request ${requestId} failed`));
    }
    browserApiState.pendingRequests.clear();
}

// ---------------------------------------------------------------------------
// 重连调度
// ---------------------------------------------------------------------------

/**
 * 为浏览器脚本到本地服务的 WSS 连接安排一次延迟重连。
 * @param reason - 触发本次重连的原因。
 */
export function scheduleBrowserApiReconnect(reason: string): void {
    if (browserApiState.manualClose || browserApiState.reconnectTimer !== null) {
        return;
    }

    browserApiState.reconnectTimer = window.setTimeout(() => {
        browserApiState.reconnectTimer = null;
        connectBrowserApiSocket().catch((error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn('[XM] browser api socket reconnect failed:', reason, msg);
        });
    }, CONFIG.apiReconnectDelayMs);
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

/**
 * 处理本地 WSS 服务返回的 RPC 响应，并把结果分发给对应的挂起请求。
 * @param event - WebSocket message 事件。
 */
export function handleBrowserApiSocketMessage(event: MessageEvent<string>): void {
    let message: RpcResponse;
    try {
        message = JSON.parse(event.data) as RpcResponse;
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

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

/**
 * 建立到本地 Node 服务的单条 WSS 长连接。
 * 该连接只在页面生命周期内建立一次，后续所有浏览器脚本通信都复用它，不再走 HTTP。
 * @returns 已就绪的 WebSocket 连接。
 */
export function connectBrowserApiSocket(): Promise<WebSocket> {
    if (browserApiState.socket && browserApiState.socket.readyState === WebSocket.OPEN) {
        return Promise.resolve(browserApiState.socket);
    }
    if (browserApiState.connectPromise) {
        return browserApiState.connectPromise;
    }

    browserApiState.manualClose = false;
    browserApiState.connectPromise = new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(CONFIG.apiWebSocketUrl);
        let settled = false;
        browserApiState.socket = socket;

        /** 统一处理连接失败，确保只 settle 一次 */
        const failConnection = (error: unknown): void => {
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
 * 在页面卸载前主动关闭浏览器脚本到本地服务的 WSS 连接，避免重连计时器继续挂着。
 */
export function closeBrowserApiSocket(): void {
    browserApiState.manualClose = true;
    if (browserApiState.reconnectTimer !== null) {
        clearTimeout(browserApiState.reconnectTimer);
        browserApiState.reconnectTimer = null;
    }
    rejectPendingBrowserApiRequests('browser api socket disposed');
    if (browserApiState.socket) {
        try {
            browserApiState.socket.close(1000, 'page unload');
        } catch (_) {
            // 关闭时出错静默忽略
        }
        browserApiState.socket = null;
    }
    browserApiState.connectPromise = null;
}

// ---------------------------------------------------------------------------
// RPC 调用
// ---------------------------------------------------------------------------

/**
 * 通过单条 WSS 长连接向本地服务发起一次 RPC 调用。
 * @param action - RPC 动作名。
 * @param payload - 请求负载，默认为空对象。
 * @param options - 调用超时配置。
 * @param options.timeoutMs - 超时毫秒数，默认使用 `CONFIG.apiRequestTimeoutMs`。
 * @returns 服务端返回的 payload。
 */
export async function browserApiRequest(
    action: string,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {}
): Promise<unknown> {
    const socket = await connectBrowserApiSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('browser api socket is not open');
    }

    const requestId = String(++browserApiState.nextRequestId);
    const timeoutMs = options.timeoutMs ?? CONFIG.apiRequestTimeoutMs;

    return await new Promise<unknown>((resolve, reject) => {
        const timerId = window.setTimeout(() => {
            browserApiState.pendingRequests.delete(requestId);
            reject(new Error(`browser api request timeout: ${action}`));
        }, timeoutMs);

        browserApiState.pendingRequests.set(requestId, {
            resolve,
            reject,
            timerId
        });

        const requestMessage: RpcRequest = {
            type: 'rpc-request',
            id: requestId,
            action,
            payload
        };

        try {
            socket.send(JSON.stringify(requestMessage));
        } catch (error: unknown) {
            clearTimeout(timerId);
            browserApiState.pendingRequests.delete(requestId);
            reject(error);
        }
    });
}
