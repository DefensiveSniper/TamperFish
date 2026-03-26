// @ts-nocheck
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCachedMediaUrl,
  restoreOriginalMediaUrl,
  restoreSessionsRemoteMediaUrls,
} = require('./media_cache.ts');

test('restores original remote url from localhost cached media url', () => {
  const localOrigin = 'https://127.0.0.1:3211';
  const originalUrl = 'https://img.alicdn.com/imgextra/i1/example.png';
  const cachedUrl = buildCachedMediaUrl(localOrigin, 'abc123abc123abc123abc123.png');

  const restored = restoreOriginalMediaUrl(cachedUrl, {
    abc123abc123abc123abc123: originalUrl,
  });

  assert.equal(restored, originalUrl);
});

test('restores cached image urls inside session snapshot before pushing to server', () => {
  const sessions = {
    chatA: {
      customerName: 'buyer',
      messages: [
        { type: 'text', content: 'hello' },
        { type: 'image', content: 'https://127.0.0.1:3211/media-cache/abc123abc123abc123abc123.png' },
      ],
    },
  };

  const normalized = restoreSessionsRemoteMediaUrls(sessions, {
    abc123abc123abc123abc123: 'https://img.alicdn.com/imgextra/i1/example.png',
  });

  assert.equal(
    normalized.chatA.messages[1].content,
    'https://img.alicdn.com/imgextra/i1/example.png'
  );
});