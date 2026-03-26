// @ts-nocheck
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildServerApiRequest,
} = require('./browser_bridge_actions.ts');

test('maps browser heartbeat to HTTP endpoint with nonce payload', () => {
  const result = buildServerApiRequest('browser.heartbeat', {
    crawlerEnabled: true,
    initialCrawlNonceHandled: 'nonce-1',
  });

  assert.deepEqual(result, {
    method: 'POST',
    path: '/api/browser/heartbeat',
    body: {
      crawlerEnabled: true,
      initialCrawlNonceHandled: 'nonce-1',
    },
  });
});

test('maps qianniu heartbeat to dedicated HTTP endpoint', () => {
  const result = buildServerApiRequest('orders.heartbeat', {
    pageUrl: 'https://myseller.taobao.com/home.htm/batch-consign',
    visibleOrderCount: 2,
  });

  assert.equal(result.method, 'POST');
  assert.equal(result.path, '/api/orders/heartbeat');
  assert.equal(result.body.visibleOrderCount, 2);
});

test('maps orders ingest to HTTP endpoint', () => {
  const result = buildServerApiRequest('orders.ingest', {
    orders: [{ orderId: '1' }],
    pageContext: { page: 1 },
  });

  assert.deepEqual(result, {
    method: 'POST',
    path: '/api/orders/ingest',
    body: {
      orders: [{ orderId: '1' }],
      pageContext: { page: 1 },
    },
  });
});

test('maps outgoing patch to per-id HTTP endpoint', () => {
  const result = buildServerApiRequest('outgoing.patch', {
    id: 9,
    status: 'sent',
    error: null,
  });

  assert.deepEqual(result, {
    method: 'PATCH',
    path: '/api/outgoing-messages/9',
    body: {
      status: 'sent',
      error: null,
    },
  });
});

test('marks media cache as local-only action', () => {
  const result = buildServerApiRequest('media.cache', {
    urls: ['https://img.alicdn.com/example.png'],
  });

  assert.equal(result, null);
});