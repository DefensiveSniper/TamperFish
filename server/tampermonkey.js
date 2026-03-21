'use strict';

const fs = require('fs');
const path = require('path');

const TAMPERMONKEY_EXTENSION_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const DEFAULT_TAMPERMONKEY_EXTENSION_VERSION = '5.4.1';
const DEFAULT_TAMPERMONKEY_EXTENSION_DIR = path.join(__dirname, '.chrome-tampermonkey-extension');
const LEVELDB_BLOCK_SIZE = 32768;
const LEVELDB_LOG_RECORD_TYPE_FULL = 1;
const LEVELDB_LOG_RECORD_TYPE_FIRST = 2;
const LEVELDB_LOG_RECORD_TYPE_MIDDLE = 3;
const LEVELDB_LOG_RECORD_TYPE_LAST = 4;
const LEVELDB_CURRENT_FILE = 'CURRENT';
const LEVELDB_MANIFEST_FILE = 'MANIFEST-000001';
const LEVELDB_LOG_FILE = '000003.log';
const LEVELDB_MANIFEST_BUFFER = Buffer.from(
  '957cb9c5220001011a6c6576656c64622e4279746577697365436f6d70617261746f72020003020400',
  'hex'
);
const USER_SCRIPT_DEFINITIONS = [
  {
    key: 'xianyu_monitor',
    uuid: '92d4fc1b-b4b9-46ae-be43-9df6ecac5809',
    position: 1,
    sourcePath: path.join(__dirname, '..', 'xianyu_capture', 'xianyu_monitor.js'),
  },
  {
    key: 'qianniu_batch_consign',
    uuid: 'f7d1905c-4044-42cb-81e7-7bac6f15f10d',
    position: 2,
    sourcePath: path.join(__dirname, '..', 'qianniu_capture', 'qianniu_batch_consign.js'),
  },
];
const CRC32C_TABLE = buildCrc32cTable();

/**
 * 生成 CRC32C 查找表，供 LevelDB 日志记录校验复用。
 * @returns {Uint32Array} 256 项 CRC32C 查找表。
 */
function buildCrc32cTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0x82F63B78 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

/**
 * 计算 Buffer 的 CRC32C 校验值。
 * @param {Buffer} buffer - 待计算的字节序列。
 * @returns {number} 无符号 CRC32C 数值。
 */
function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (~crc) >>> 0;
}

/**
 * 按 LevelDB 规则掩码处理 CRC 校验值，避免固定模式在日志里反复出现。
 * @param {number} value - 原始 CRC32C 数值。
 * @returns {number} 掩码后的校验值。
 */
function maskLevelDbChecksum(value) {
  return ((((value >>> 15) | (value << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

/**
 * 将 32 位整数编码为无符号 Varint，供 LevelDB WriteBatch 使用。
 * @param {number} value - 待编码整数。
 * @returns {Buffer} Varint 编码结果。
 */
function encodeVarint32(value) {
  const bytes = [];
  let remaining = value >>> 0;

  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

/**
 * 将字符串编码成 LevelDB WriteBatch 所需的长度前缀字节串。
 * @param {string} value - 待编码文本。
 * @returns {Buffer} 长度前缀 + UTF-8 内容。
 */
function encodeLengthPrefixedString(value) {
  const body = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeVarint32(body.length), body]);
}

/**
 * 把一组 put 操作编码为单个 LevelDB WriteBatch。
 * @param {{ key: string, value: string }[]} operations - 顺序写入的键值列表。
 * @returns {Buffer} WriteBatch 二进制内容。
 */
function buildWriteBatch(operations) {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(0n, 0);
  header.writeUInt32LE(operations.length, 8);

  const records = operations.map((operation) => {
    return Buffer.concat([
      Buffer.from([1]),
      encodeLengthPrefixedString(operation.key),
      encodeLengthPrefixedString(operation.value),
    ]);
  });

  return Buffer.concat([header, ...records]);
}

/**
 * 将 WriteBatch 序列化为 LevelDB `.log` 文件格式。
 * @param {Buffer} payload - 单个 WriteBatch 内容。
 * @returns {Buffer} 可直接写入 `000003.log` 的日志数据。
 */
function buildLevelDbLogFile(payload) {
  const chunks = [];
  let fileOffset = 0;
  let offset = 0;
  let begin = true;

  while (offset < payload.length) {
    const blockOffset = fileOffset % LEVELDB_BLOCK_SIZE;
    const available = LEVELDB_BLOCK_SIZE - blockOffset;

    if (available < 7) {
      const padding = Buffer.alloc(available);
      chunks.push(padding);
      fileOffset += padding.length;
      continue;
    }

    const fragmentLength = Math.min(payload.length - offset, available - 7);
    const fragment = payload.subarray(offset, offset + fragmentLength);
    const end = offset + fragmentLength >= payload.length;
    const recordType = begin
      ? end
        ? LEVELDB_LOG_RECORD_TYPE_FULL
        : LEVELDB_LOG_RECORD_TYPE_FIRST
      : end
      ? LEVELDB_LOG_RECORD_TYPE_LAST
      : LEVELDB_LOG_RECORD_TYPE_MIDDLE;
    const checksumPayload = Buffer.concat([Buffer.from([recordType]), fragment]);
    const header = Buffer.alloc(7);
    header.writeUInt32LE(maskLevelDbChecksum(crc32c(checksumPayload)), 0);
    header.writeUInt16LE(fragment.length, 4);
    header.writeUInt8(recordType, 6);
    chunks.push(header, fragment);
    fileOffset += header.length + fragment.length;
    offset += fragmentLength;
    begin = false;
  }

  return Buffer.concat(chunks);
}

/**
 * 拆分用户脚本源码中的 metadata 头部与正文，便于注入更新地址和生成 `.meta.js`。
 * @param {string} source - 原始用户脚本源码。
 * @returns {{ header: string, body: string }} 拆分结果。
 */
function splitUserScriptSource(source) {
  const normalized = String(source || '').replace(/\r\n/g, '\n');
  const match = normalized.match(/(^\/\/ ==UserScript==\n[\s\S]*?\n\/\/ ==\/UserScript==)(\n?[\s\S]*)$/u);
  if (!match) {
    throw new Error('用户脚本缺少合法的 ==UserScript== 头部');
  }

  return {
    header: match[1],
    body: match[2] || '',
  };
}

/**
 * 读取并规范化单个项目内用户脚本源码。
 * @param {string} sourcePath - 用户脚本文件路径。
 * @returns {string} 规范化后的 UTF-8 源码。
 */
function readUserScriptSource(sourcePath) {
  return fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 根据当前服务端端口生成脚本更新地址，保证 fresh profile 后续可继续走本地更新。
 * @param {number} serverPort - API 服务端口。
 * @param {string} scriptKey - 用户脚本标识。
 * @returns {{ downloadUrl: string, updateUrl: string }} 下载与更新地址。
 */
function buildUserScriptUrls(serverPort, scriptKey) {
  const origin = `http://localhost:${serverPort}`;
  return {
    downloadUrl: `${origin}/scripts/${scriptKey}.user.js`,
    updateUrl: `${origin}/scripts/${scriptKey}.meta.js`,
  };
}

/**
 * 将下载地址与更新地址注入用户脚本 metadata 头部，便于 Tampermonkey 后续自动更新。
 * @param {string} source - 原始用户脚本源码。
 * @param {{ downloadUrl: string, updateUrl: string }} urls - 需要注入的地址。
 * @returns {string} 注入后的完整源码。
 */
function injectUserScriptUrls(source, urls) {
  const { header, body } = splitUserScriptSource(source);
  const nextHeaderLines = header
    .split('\n')
    .filter((line) => !/^\s*\/\/\s+@(downloadURL|updateURL)\b/u.test(line));

  const endIndex = nextHeaderLines.findIndex((line) => /^\s*\/\/ ==\/UserScript==\s*$/u.test(line));
  nextHeaderLines.splice(endIndex, 0, `// @downloadURL  ${urls.downloadUrl}`);
  nextHeaderLines.splice(endIndex + 1, 0, `// @updateURL    ${urls.updateUrl}`);

  return `${nextHeaderLines.join('\n')}${body}`;
}

/**
 * 解析用户脚本 metadata 头部，提取 Tampermonkey 建库需要的关键字段。
 * @param {string} source - 已规范化的用户脚本源码。
 * @returns {Record<string, string[]>} 按键聚合后的 metadata 字段映射。
 */
function parseUserScriptMetadata(source) {
  const { header } = splitUserScriptSource(source);
  const metadata = {};

  for (const line of header.split('\n')) {
    const match = line.match(/^\s*\/\/\s+@([^\s]+)\s*(.*)$/u);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2].trim();
    if (!metadata[key]) {
      metadata[key] = [];
    }
    metadata[key].push(value);
  }

  return metadata;
}

/**
 * 将单个 metadata 字段规范化为单值文本，缺失时返回 null。
 * @param {Record<string, string[]>} metadata - 解析后的 metadata 映射。
 * @param {string} key - 目标字段名。
 * @returns {string | null} 目标字段值。
 */
function getSingleMetadataValue(metadata, key) {
  const values = Array.isArray(metadata[key]) ? metadata[key] : [];
  return values.length > 0 ? values[0] : null;
}

/**
 * 基于项目脚本源码生成 Tampermonkey 存储所需的 `@meta` / `@re` / `@source` 三类记录。
 * @param {{ key: string, uuid: string, position: number, sourcePath: string }} definition - 脚本定义。
 * @param {number} serverPort - 当前服务端端口。
 * @returns {{ metaKey: string, metaValue: string, reKey: string, reValue: string, sourceKey: string, sourceValue: string }} 序列化结果。
 */
function buildTampermonkeyScriptEntries(definition, serverPort) {
  const urls = buildUserScriptUrls(serverPort, definition.key);
  const source = injectUserScriptUrls(readUserScriptSource(definition.sourcePath), urls);
  const metadata = parseUserScriptMetadata(source);
  const header = splitUserScriptSource(source).header;
  const matches = metadata.match || [];
  const includes = metadata.include || [];
  const excludes = metadata.exclude || [];
  const connects = metadata.connect || [];
  const grants = metadata.grant && metadata.grant.length > 0 ? metadata.grant : ['none'];
  const runAt = getSingleMetadataValue(metadata, 'run-at');
  const namespace = getSingleMetadataValue(metadata, 'namespace') || 'http://tampermonkey.net/';
  const now = Date.now();

  const metaValue = {
    antifeatures: {},
    author: getSingleMetadataValue(metadata, 'author'),
    blockers: [],
    connects,
    copyright: null,
    description: getSingleMetadataValue(metadata, 'description'),
    description_i18n: {},
    downloadURL: urls.downloadUrl,
    enabled: true,
    evilness: 0,
    excludes,
    fileURL: urls.downloadUrl,
    grant: grants,
    header,
    homepage: null,
    icon: null,
    icon64: null,
    includes,
    lastModified: now,
    matches,
    name: getSingleMetadataValue(metadata, 'name') || definition.key,
    name_i18n: {},
    namespace,
    options: {
      check_for_updates: true,
      comment: null,
      compat_foreach: false,
      compat_metadata: false,
      compat_powerful_this: null,
      compat_wrappedjsobject: false,
      compatopts_for_requires: true,
      noframes: metadata.noframes ? true : null,
      override: {
        merge_connects: true,
        merge_excludes: true,
        merge_includes: true,
        merge_matches: true,
        orig_connects: connects,
        orig_excludes: excludes,
        orig_includes: includes,
        orig_matches: matches,
        orig_noframes: metadata.noframes ? true : null,
        orig_run_at: runAt,
        orig_run_in: [],
        orig_tags: [],
        use_blockers: [],
        use_connects: [],
        use_excludes: [],
        use_includes: [],
        use_matches: [],
      },
      run_at: null,
      run_in: null,
      sandbox: null,
      tags: [],
      unwrap: null,
      user_modified: null,
    },
    position: definition.position,
    requires: [],
    resources: [],
    supportURL: null,
    sync: {},
    updateURL: urls.updateUrl,
    uuid: definition.uuid,
    version: getSingleMetadataValue(metadata, 'version'),
    webRequest: null,
  };

  return {
    metaKey: `!extdb.@meta#${definition.uuid}`,
    metaValue: JSON.stringify({ origin: 'normal', value: metaValue }),
    reKey: `!extdb.@re#${definition.uuid}`,
    reValue: JSON.stringify({
      origin: 'normal',
      value: {
        exc: excludes,
        inc: includes,
        match: matches,
      },
    }),
    sourceKey: `!extdb.@source#${definition.uuid}`,
    sourceValue: JSON.stringify({
      origin: 'normal',
      value: source,
    }),
  };
}

/**
 * 生成 fresh profile 所需的最小 Tampermonkey Local Extension Settings 键值集。
 * @param {number} serverPort - 当前服务端端口。
 * @returns {{ key: string, value: string }[]} 顺序写入的 LevelDB put 操作。
 */
function buildTampermonkeySeedOperations(serverPort) {
  const now = Date.now();
  const operations = [
    {
      key: '!extdb.#schema',
      value: JSON.stringify({ origin: 'normal', value: '6226' }),
    },
    {
      key: '!extdb.#version',
      value: JSON.stringify({ origin: 'normal', value: DEFAULT_TAMPERMONKEY_EXTENSION_VERSION }),
    },
    {
      key: '!extdb.#begging',
      value: JSON.stringify({
        origin: 'normal',
        value: {
          first_run: {
            ts: now,
            type: 'from_init',
          },
        },
      }),
    },
    {
      key: '!extdb.#laststart',
      value: JSON.stringify({ origin: 'normal', value: now }),
    },
  ];

  for (const definition of USER_SCRIPT_DEFINITIONS) {
    const entries = buildTampermonkeyScriptEntries(definition, serverPort);
    operations.push(
      { key: entries.metaKey, value: entries.metaValue },
      { key: entries.reKey, value: entries.reValue },
      { key: entries.sourceKey, value: entries.sourceValue }
    );
  }

  return operations;
}

/**
 * 将最小 LevelDB 数据库写入指定目录，供 Chrome 扩展本地存储直接读取。
 * @param {string} targetDir - `Local Extension Settings/<extension-id>` 目录。
 * @param {{ key: string, value: string }[]} operations - 需要写入的键值集合。
 */
function writeMinimalLevelDb(targetDir, operations) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, LEVELDB_CURRENT_FILE), `${LEVELDB_MANIFEST_FILE}\n`);
  fs.writeFileSync(path.join(targetDir, LEVELDB_MANIFEST_FILE), LEVELDB_MANIFEST_BUFFER);
  fs.writeFileSync(
    path.join(targetDir, LEVELDB_LOG_FILE),
    buildLevelDbLogFile(buildWriteBatch(operations))
  );
}

/**
 * 检查当前 profile 是否已存在 Tampermonkey 的 Local Extension Settings 数据库。
 * @param {string} profileDir - Chrome profile 目录。
 * @returns {boolean} 若已存在有效 LevelDB 元数据则返回 true。
 */
function hasTampermonkeyLocalSettings(profileDir) {
  const currentFile = path.join(
    profileDir,
    'Local Extension Settings',
    TAMPERMONKEY_EXTENSION_ID,
    LEVELDB_CURRENT_FILE
  );
  return fs.existsSync(currentFile);
}

/**
 * 在 fresh profile 场景下初始化 Tampermonkey 用户脚本数据库，避免首次启动仍需手工导入脚本。
 * @param {{ chromeUserDataDir: string, profileDirectory: string, serverPort: number }} options - 当前 Chrome/Profile 配置。
 * @returns {{ seeded: boolean, targetDir: string }} 是否执行过初始化以及目标目录。
 */
function ensureTampermonkeyProfileSeed(options) {
  const profileDir = path.join(options.chromeUserDataDir, options.profileDirectory);
  const targetDir = path.join(
    profileDir,
    'Local Extension Settings',
    TAMPERMONKEY_EXTENSION_ID
  );

  if (hasTampermonkeyLocalSettings(profileDir)) {
    return { seeded: false, targetDir };
  }

  writeMinimalLevelDb(targetDir, buildTampermonkeySeedOperations(options.serverPort));
  return { seeded: true, targetDir };
}

/**
 * 判断当前 profile 是否已经把 Tampermonkey 作为正式安装扩展持久化到 profile 内。
 * @param {{ chromeUserDataDir: string, profileDirectory: string }} options - 当前 Chrome/Profile 配置。
 * @returns {boolean} 是否已存在 profile 内扩展目录。
 */
function hasProfileInstalledTampermonkey(options) {
  const extensionRoot = path.join(
    options.chromeUserDataDir,
    options.profileDirectory,
    'Extensions',
    TAMPERMONKEY_EXTENSION_ID
  );
  return fs.existsSync(extensionRoot);
}

/**
 * 返回 fresh profile 启动时应通过 `--load-extension` 注入的 Tampermonkey unpacked 目录。
 * @param {{ chromeTampermonkeyExtensionDir: string, chromeUserDataDir: string, profileDirectory: string }} options - 当前 Chrome/Profile 配置。
 * @returns {string | null} 需要注入的扩展目录；已有正式安装时返回 null。
 */
function resolveTampermonkeyLoadExtensionDir(options) {
  if (hasProfileInstalledTampermonkey(options)) {
    return null;
  }
  if (!fs.existsSync(options.chromeTampermonkeyExtensionDir)) {
    throw new Error(`未找到项目内 Tampermonkey 扩展目录: ${options.chromeTampermonkeyExtensionDir}`);
  }
  return options.chromeTampermonkeyExtensionDir;
}

/**
 * 读取供 HTTP 发布的用户脚本内容；`.user.js` 返回完整源码，`.meta.js` 仅返回 metadata 头部。
 * @param {string} scriptKey - 目标脚本标识。
 * @param {number} serverPort - 当前服务端端口。
 * @param {'user' | 'meta'} variant - 返回完整脚本还是 metadata。
 * @returns {{ body: string, sourcePath: string }} 响应内容与源文件路径。
 */
function getPublishedUserScript(scriptKey, serverPort, variant) {
  const definition = USER_SCRIPT_DEFINITIONS.find((item) => item.key === scriptKey);
  if (!definition) {
    throw new Error(`unknown script: ${scriptKey}`);
  }

  const source = injectUserScriptUrls(
    readUserScriptSource(definition.sourcePath),
    buildUserScriptUrls(serverPort, definition.key)
  );
  if (variant === 'meta') {
    return {
      body: `${splitUserScriptSource(source).header}\n`,
      sourcePath: definition.sourcePath,
    };
  }

  return {
    body: source,
    sourcePath: definition.sourcePath,
  };
}

module.exports = {
  DEFAULT_TAMPERMONKEY_EXTENSION_DIR,
  TAMPERMONKEY_EXTENSION_ID,
  ensureTampermonkeyProfileSeed,
  getPublishedUserScript,
  resolveTampermonkeyLoadExtensionDir,
};
