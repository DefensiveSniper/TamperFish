// @ts-nocheck
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MEDIA_CACHE_DIR = path.join(__dirname, '.browser-media-cache');
const MEDIA_CACHE_URL_PREFIX = '/media-cache/';
const MEDIA_CACHE_MANIFEST_PATH = path.join(MEDIA_CACHE_DIR, 'manifest.json');

const CONTENT_TYPE_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

function ensureMediaCacheDir() {
  fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
}

function normalizeUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getCacheHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
}

function readMediaCacheManifest() {
  ensureMediaCacheDir();
  if (!fs.existsSync(MEDIA_CACHE_MANIFEST_PATH)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(MEDIA_CACHE_MANIFEST_PATH, 'utf8').trim();
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeMediaCacheManifest(manifest) {
  ensureMediaCacheDir();
  const tempPath = `${MEDIA_CACHE_MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2));
  fs.renameSync(tempPath, MEDIA_CACHE_MANIFEST_PATH);
}

function upsertMediaCacheManifestEntry(hash, entry) {
  const manifest = readMediaCacheManifest();
  manifest[hash] = {
    ...(manifest[hash] || {}),
    ...entry,
  };
  writeMediaCacheManifest(manifest);
}

function findExistingCachedFile(hash) {
  ensureMediaCacheDir();
  const entries = fs.readdirSync(MEDIA_CACHE_DIR);
  return entries.find((entry) => entry === hash || entry.startsWith(`${hash}.`)) || null;
}

function resolveExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname || '';
    const extension = path.extname(pathname).toLowerCase();
    return CONTENT_TYPE_BY_EXTENSION[extension] ? extension : '';
  } catch (_) {
    return '';
  }
}

function resolveExtensionFromContentType(contentType) {
  const normalized = normalizeUrl(contentType).toLowerCase();
  if (normalized.includes('image/png')) return '.png';
  if (normalized.includes('image/jpeg')) return '.jpg';
  if (normalized.includes('image/webp')) return '.webp';
  if (normalized.includes('image/gif')) return '.gif';
  if (normalized.includes('image/bmp')) return '.bmp';
  if (normalized.includes('image/svg+xml')) return '.svg';
  if (normalized.includes('image/avif')) return '.avif';
  return '.png';
}

function buildCachedMediaUrl(publicOrigin, fileName) {
  return `${normalizeUrl(publicOrigin).replace(/\/$/, '')}${MEDIA_CACHE_URL_PREFIX}${encodeURIComponent(fileName)}`;
}

function isCachedMediaUrl(url, publicOrigin = '') {
  const normalizedUrl = normalizeUrl(url);
  const normalizedOrigin = normalizeUrl(publicOrigin).replace(/\/$/, '');
  return !!normalizedUrl
    && !!normalizedOrigin
    && normalizedUrl.startsWith(`${normalizedOrigin}${MEDIA_CACHE_URL_PREFIX}`);
}

function shouldCacheRemoteImage(url, publicOrigin) {
  const normalizedUrl = normalizeUrl(url);
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    return false;
  }
  return !isCachedMediaUrl(normalizedUrl, publicOrigin);
}

async function cacheRemoteImage(url, { publicOrigin }) {
  const normalizedUrl = normalizeUrl(url);
  if (!shouldCacheRemoteImage(normalizedUrl, publicOrigin)) {
    return normalizedUrl;
  }

  const hash = getCacheHash(normalizedUrl);
  const manifest = readMediaCacheManifest();
  const manifestEntry = manifest[hash];
  const existingFile = manifestEntry?.fileName || findExistingCachedFile(hash);
  if (existingFile) {
    upsertMediaCacheManifestEntry(hash, {
      fileName: existingFile,
      originalUrl: normalizedUrl,
      updatedAt: Date.now(),
    });
    return buildCachedMediaUrl(publicOrigin, existingFile);
  }

  try {
    const response = await fetch(normalizedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.goofish.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`image fetch HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/^image\//i.test(contentType)) {
      throw new Error(`unsupported content-type: ${contentType || 'unknown'}`);
    }

    const extension = resolveExtensionFromUrl(normalizedUrl)
      || resolveExtensionFromContentType(contentType);
    const fileName = `${hash}${extension}`;
    const filePath = path.join(MEDIA_CACHE_DIR, fileName);
    ensureMediaCacheDir();

    if (!fs.existsSync(filePath)) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, buffer);
      fs.renameSync(tempPath, filePath);
    }

    upsertMediaCacheManifestEntry(hash, {
      fileName,
      originalUrl: normalizedUrl,
      updatedAt: Date.now(),
    });

    return buildCachedMediaUrl(publicOrigin, fileName);
  } catch (error) {
    console.warn('[client-media-cache] cache failed:', normalizedUrl, error.message || error);
    return normalizedUrl;
  }
}

async function cacheRemoteImages(urls = [], { publicOrigin }) {
  const normalizedUrls = Array.from(
    new Set(
      (Array.isArray(urls) ? urls : [])
        .map(normalizeUrl)
        .filter(Boolean)
    )
  );

  const mappings = {};
  for (const url of normalizedUrls) {
    mappings[url] = await cacheRemoteImage(url, { publicOrigin });
  }
  return mappings;
}

function extractCacheHashFromUrl(url) {
  const normalizedUrl = normalizeUrl(url);
  const match = normalizedUrl.match(/\/media-cache\/([a-f0-9]{24})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i);
  return match ? match[1].toLowerCase() : null;
}

function resolveManifestOriginalUrl(entry) {
  if (!entry) {
    return null;
  }
  if (typeof entry === 'string') {
    return entry;
  }
  return normalizeUrl(entry.originalUrl) || null;
}

function restoreOriginalMediaUrl(url, manifest = readMediaCacheManifest()) {
  const hash = extractCacheHashFromUrl(url);
  if (!hash) {
    return url;
  }

  const originalUrl = resolveManifestOriginalUrl(manifest[hash]);
  return originalUrl || url;
}

function restoreSessionsRemoteMediaUrls(sessions = {}, manifest = readMediaCacheManifest()) {
  const entries = Object.entries(sessions || {}).map(([chatKey, session]) => {
    const nextMessages = Array.isArray(session?.messages)
      ? session.messages.map((message) => {
          if (message?.type !== 'image') {
            return message;
          }

          const restoredUrl = restoreOriginalMediaUrl(message.content, manifest);
          return restoredUrl === message.content
            ? message
            : { ...message, content: restoredUrl };
        })
      : session?.messages;

    return [chatKey, {
      ...session,
      messages: nextMessages,
    }];
  });

  return Object.fromEntries(entries);
}

function serveCachedMediaRequest(req, res) {
  const requestPath = decodeURIComponent((req.url || '').split('?')[0] || '');
  if (!requestPath.startsWith(MEDIA_CACHE_URL_PREFIX)) {
    return false;
  }

  const relativePath = requestPath.slice(MEDIA_CACHE_URL_PREFIX.length);
  if (!relativePath || relativePath.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return true;
  }

  const filePath = path.join(MEDIA_CACHE_DIR, relativePath);
  if (!filePath.startsWith(MEDIA_CACHE_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return true;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

module.exports = {
  MEDIA_CACHE_DIR,
  MEDIA_CACHE_MANIFEST_PATH,
  MEDIA_CACHE_URL_PREFIX,
  buildCachedMediaUrl,
  cacheRemoteImages,
  readMediaCacheManifest,
  restoreOriginalMediaUrl,
  restoreSessionsRemoteMediaUrls,
  serveCachedMediaRequest,
};