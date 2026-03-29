// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const LOADED_ENV_FILES = new Set();

/**
 * 去掉环境变量值外围的引号，并处理双引号下的常见转义。
 * @param {string} rawValue - `.env` 文件中解析出的原始值文本。
 * @returns {string} 归一化后的变量值。
 */
function normalizeEnvValue(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    return '';
  }

  const quote = value[0];
  const isQuoted = (quote === '"' || quote === '\'') && value[value.length - 1] === quote;
  if (!isQuoted) {
    return value.replace(/\s+#.*$/, '').trim();
  }

  const innerValue = value.slice(1, -1);
  if (quote === '\'') {
    return innerValue;
  }

  return innerValue
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * 将单行 `.env` 文本解析为键值对；无效行和注释行返回 `null`。
 * @param {string} line - 单行 `.env` 文本。
 * @returns {{ key: string, value: string } | null} 解析结果。
 */
function parseEnvLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const normalizedLine = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trim()
    : trimmed;
  const separatorIndex = normalizedLine.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const key = normalizedLine.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  const value = normalizeEnvValue(normalizedLine.slice(separatorIndex + 1));
  return { key, value };
}

/**
 * 从 `.env` 文件内容中提取所有键值对。
 * @param {string} fileContent - `.env` 原始文本内容。
 * @returns {Array<{ key: string, value: string }>} 解析出的变量列表。
 */
function parseEnvFile(fileContent) {
  return String(fileContent ?? '')
    .split(/\r?\n/)
    .map(parseEnvLine)
    .filter(Boolean);
}

/**
 * 加载单个 `.env` 文件，并且只填充当前进程中尚未显式设置的变量。
 * @param {string} filePath - `.env` 文件绝对路径。
 */
function loadEnvFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (LOADED_ENV_FILES.has(resolvedPath) || !fs.existsSync(resolvedPath)) {
    return;
  }

  const entries = parseEnvFile(fs.readFileSync(resolvedPath, 'utf8'));
  for (const entry of entries) {
    if (process.env[entry.key] == null) {
      process.env[entry.key] = entry.value;
    }
  }

  LOADED_ENV_FILES.add(resolvedPath);
}

/**
 * 按顺序加载多个可选 `.env` 文件；不存在的文件自动跳过。
 * @param {string[]} filePaths - 候选 `.env` 文件路径列表。
 */
function loadOptionalEnvFiles(filePaths = []) {
  for (const filePath of filePaths) {
    if (!filePath) {
      continue;
    }
    loadEnvFile(filePath);
  }
}

module.exports = {
  loadOptionalEnvFiles,
};
