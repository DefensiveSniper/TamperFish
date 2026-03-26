// @ts-nocheck
'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * 基于本地 bridge 证书生成 Chrome 可接受的 SPKI allowlist hash。
 * @param {string} certPath
 * @returns {string}
 */
function computeCertificateSpkiHash(certPath) {
  if (!certPath || !fs.existsSync(certPath)) {
    return '';
  }

  const certificatePem = fs.readFileSync(certPath, 'utf8');
  const certificate = new crypto.X509Certificate(certificatePem);
  const spkiDer = certificate.publicKey.export({
    type: 'spki',
    format: 'der',
  });

  return crypto.createHash('sha256').update(spkiDer).digest('base64');
}

/**
 * 构建 Chrome 接受本地 TLS bridge 所需的启动参数。
 * @param {string} spkiHash
 * @returns {string[]}
 */
function buildChromeTlsArgs(spkiHash) {
  const args = ['--allow-insecure-localhost'];
  if (spkiHash) {
    args.push(`--ignore-certificate-errors-spki-list=${spkiHash}`);
  }
  return args;
}

module.exports = {
  buildChromeTlsArgs,
  computeCertificateSpkiHash,
};