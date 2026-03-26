// @ts-nocheck
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChromeTlsArgs,
} = require('./chrome_tls.ts');

test('includes allow-insecure-localhost and spki allowlist when hash exists', () => {
  const args = buildChromeTlsArgs('base64spkihash');

  assert.deepEqual(args, [
    '--allow-insecure-localhost',
    '--ignore-certificate-errors-spki-list=base64spkihash',
  ]);
});

test('falls back to allow-insecure-localhost when spki hash is missing', () => {
  const args = buildChromeTlsArgs('');

  assert.deepEqual(args, [
    '--allow-insecure-localhost',
  ]);
});