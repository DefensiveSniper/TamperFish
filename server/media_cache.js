// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const MEDIA_CACHE_DIR = path.join(__dirname, 'public', 'media-cache');
const MEDIA_CACHE_URL_PREFIX = '/media-cache/';
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
    }
    catch (_) {
        return '';
    }
}
function resolveExtensionFromContentType(contentType) {
    const normalized = normalizeUrl(contentType).toLowerCase();
    if (normalized.includes('image/png'))
        return '.png';
    if (normalized.includes('image/jpeg'))
        return '.jpg';
    if (normalized.includes('image/webp'))
        return '.webp';
    if (normalized.includes('image/gif'))
        return '.gif';
    if (normalized.includes('image/bmp'))
        return '.bmp';
    if (normalized.includes('image/svg+xml'))
        return '.svg';
    if (normalized.includes('image/avif'))
        return '.avif';
    return '.png';
}
function isCachedMediaUrl(url, publicOrigin) {
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
function buildCachedMediaUrl(publicOrigin, fileName) {
    return `${normalizeUrl(publicOrigin).replace(/\/$/, '')}${MEDIA_CACHE_URL_PREFIX}${encodeURIComponent(fileName)}`;
}
async function cacheRemoteImage(url, { publicOrigin }) {
    const normalizedUrl = normalizeUrl(url);
    if (!shouldCacheRemoteImage(normalizedUrl, publicOrigin)) {
        return normalizedUrl;
    }
    const hash = getCacheHash(normalizedUrl);
    const existingFile = findExistingCachedFile(hash);
    if (existingFile) {
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
        return buildCachedMediaUrl(publicOrigin, fileName);
    }
    catch (error) {
        console.warn('[media-cache] cache failed:', normalizedUrl, error.message || error);
        return normalizedUrl;
    }
}
async function cacheRemoteImages(urls = [], { publicOrigin }) {
    const normalizedUrls = Array.from(new Set((Array.isArray(urls) ? urls : [])
        .map(normalizeUrl)
        .filter(Boolean)));
    const mappings = {};
    for (const url of normalizedUrls) {
        mappings[url] = await cacheRemoteImage(url, { publicOrigin });
    }
    return mappings;
}
async function localizeMessages(messages = [], { publicOrigin }) {
    const list = Array.isArray(messages) ? messages : [];
    const remoteUrls = list
        .filter((message) => message?.type === 'image' && shouldCacheRemoteImage(message?.content, publicOrigin))
        .map((message) => message.content);
    if (!remoteUrls.length) {
        return list;
    }
    const mappings = await cacheRemoteImages(remoteUrls, { publicOrigin });
    return list.map((message) => {
        if (message?.type !== 'image') {
            return message;
        }
        const nextContent = mappings[normalizeUrl(message.content)];
        return nextContent && nextContent !== message.content
            ? { ...message, content: nextContent }
            : message;
    });
}
async function localizeSessions(sessions = {}, { publicOrigin }) {
    const entries = await Promise.all(Object.entries(sessions || {}).map(async ([chatKey, session]) => {
        const nextMessages = await localizeMessages(session?.messages || [], { publicOrigin });
        return [chatKey, {
                ...session,
                messages: nextMessages,
            }];
    }));
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
    MEDIA_CACHE_URL_PREFIX,
    cacheRemoteImages,
    localizeMessages,
    localizeSessions,
    serveCachedMediaRequest,
};
