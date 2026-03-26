// @ts-nocheck
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { localizeMessages } = require('./media_cache.ts');

const MEDIA_CACHE_DIR = path.join(__dirname, 'public', 'media-cache');

test('rewrites historical localhost media-cache urls to current server origin without refetching', async () => {
  const fileName = '983bd3a37bf4962260eff533.png';
  const filePath = path.join(MEDIA_CACHE_DIR, fileName);
  fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  fs.writeFileSync(filePath, 'test-image');

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for existing localhost media-cache files');
  };

  try {
    const messages = await localizeMessages([
      { type: 'image', content: `https://localhost:3211/media-cache/${fileName}` },
    ], {
      publicOrigin: 'http://192.168.1.9:3210',
    });

    assert.equal(messages[0].content, `http://192.168.1.9:3210/media-cache/${fileName}`);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(filePath, { force: true });
  }
});