// @ts-nocheck
'use strict';

/**
 * 将浏览器侧 RPC 动作映射为 server 纯 HTTP API 请求。
 * `media.cache` 仅在 client 本地处理，因此返回 null。
 * @param {string} action
 * @param {Record<string, any>} payload
 * @returns {{ method: string, path: string, body?: Record<string, any> } | null}
 */
function buildServerApiRequest(action, payload = {}) {
  switch (action) {
    case 'settings.patch':
      return {
        method: 'PATCH',
        path: '/api/settings',
        body: payload,
      };

    case 'browser.heartbeat':
      return {
        method: 'POST',
        path: '/api/browser/heartbeat',
        body: payload,
      };

    case 'orders.heartbeat':
      return {
        method: 'POST',
        path: '/api/orders/heartbeat',
        body: payload,
      };

    case 'orders.ingest':
      return {
        method: 'POST',
        path: '/api/orders/ingest',
        body: payload,
      };

    case 'outgoing.claim':
      return {
        method: 'POST',
        path: '/api/outgoing-messages/claim',
        body: payload,
      };

    case 'outgoing.patch': {
      const id = Number(payload?.id);
      return {
        method: 'PATCH',
        path: `/api/outgoing-messages/${id}`,
        body: {
          status: payload?.status,
          error: payload?.error ?? null,
        },
      };
    }

    case 'media.cache':
      return null;

    default:
      throw new Error(`unsupported action: ${action}`);
  }
}

module.exports = {
  buildServerApiRequest,
};