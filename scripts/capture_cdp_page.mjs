import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 创建目录，确保后续写文件不会因为路径不存在而失败。
 * @param {string} dirPath - 目标目录。
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 将文件名中的非法字符替换为下划线，避免写盘失败。
 * @param {string} value - 原始文件名片段。
 * @returns {string}
 */
function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 根据 URL 与资源类型生成稳定的本地输出路径。
 * @param {string} resourceUrl - 资源原始 URL。
 * @param {string} type - CDP 资源类型。
 * @returns {string}
 */
function localAssetPathFor(resourceUrl, type) {
  const url = new URL(resourceUrl);
  const pathname = url.pathname === '/' ? '/index' : url.pathname;
  const extFromPath = path.extname(pathname);
  const fallbackExtMap = {
    Stylesheet: '.css',
    Script: '.js',
    Image: '.bin',
    Font: '.woff2',
    Document: '.html',
  };
  const ext = extFromPath || fallbackExtMap[type] || '.bin';
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));
  const fileBase = segments.length > 0 ? segments.join('/') : 'root';
  const queryHash = url.search ? `__${Buffer.from(url.search).toString('base64url').slice(0, 12)}` : '';
  return path.posix.join('assets', sanitizeSegment(url.hostname), `${fileBase}${queryHash}${extFromPath ? '' : ext}`);
}

/**
 * 从资源树中递归提取所有 frame 资源，方便后续按 URL 查询内容。
 * @param {any} frameTree - CDP Page.getResourceTree 返回的 frameTree。
 * @param {Map<string, {frameId: string, url: string, type: string}>} resourceMap - 输出映射。
 * @returns {void}
 */
function collectResources(frameTree, resourceMap) {
  if (!frameTree?.frame) {
    return;
  }

  const frameId = frameTree.frame.id;
  const frameUrl = frameTree.frame.url;
  if (frameUrl && /^https?:/i.test(frameUrl)) {
    resourceMap.set(frameUrl, {
      frameId,
      url: frameUrl,
      type: 'Document',
    });
  }

  for (const resource of frameTree.resources || []) {
    if (!resource?.url || !/^https?:/i.test(resource.url)) {
      continue;
    }
    resourceMap.set(resource.url, {
      frameId,
      url: resource.url,
      type: resource.type || 'Other',
    });
  }

  for (const child of frameTree.childFrames || []) {
    collectResources(child, resourceMap);
  }
}

/**
 * 从文本中提取绝对资源 URL，覆盖 HTML 属性与 CSS url()/@import。
 * @param {string} text - 待扫描文本。
 * @returns {string[]}
 */
function extractAbsoluteUrls(text) {
  const found = new Set();
  const patterns = [
    /(https?:\/\/[^"'`\s)<>]+)/g,
    /url\((['"]?)(https?:\/\/[^)"']+)\1\)/g,
    /@import\s+(?:url\()?['"]?(https?:\/\/[^)"';]+)['"]?\)?/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const url = match[2] || match[1];
      if (url) {
        found.add(url);
      }
    }
  }

  return Array.from(found);
}

/**
 * 将文本中的远程 URL 替换为本地资源路径。
 * @param {string} text - 原始文本。
 * @param {Map<string, string>} replacements - URL -> 本地相对路径 的映射。
 * @returns {string}
 */
function replaceUrls(text, replacements) {
  let output = text;
  const sorted = Array.from(replacements.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [remoteUrl, localPath] of sorted) {
    output = output.split(remoteUrl).join(localPath);
  }
  return output;
}

/**
 * 通过 CDP WebSocket 发送命令并等待结果。
 * @param {WebSocket} socket - 已连接的 WebSocket。
 * @returns {(method: string, params?: Record<string, unknown>) => Promise<any>}
 */
function createCdpClient(socket) {
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data.toString());
    if (!payload.id) {
      return;
    }
    const resolver = pending.get(payload.id);
    if (!resolver) {
      return;
    }
    pending.delete(payload.id);
    if (payload.error) {
      resolver.reject(new Error(payload.error.message || `CDP error for ${payload.id}`));
      return;
    }
    resolver.resolve(payload.result);
  });

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
}

/**
 * 等待 WebSocket 连接建立。
 * @param {WebSocket} socket - 待连接的 WebSocket。
 * @returns {Promise<void>}
 */
async function waitForOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (error) => reject(error), { once: true });
  });
}

/**
 * 获取当前页面的静态 DOM 字符串，并把常见资源属性转成绝对地址。
 * @param {(method: string, params?: Record<string, unknown>) => Promise<any>} cdp - CDP 调用函数。
 * @returns {Promise<{ html: string, pageUrl: string }>}
 */
async function getSerializedDom(cdp) {
  const expression = `(() => {
    const clone = document.documentElement.cloneNode(true);
    const attrs = ['href', 'src', 'poster'];
    clone.querySelectorAll('*').forEach((node) => {
      attrs.forEach((attr) => {
        if (node.hasAttribute && node.hasAttribute(attr)) {
          const value = node.getAttribute(attr);
          if (value && !value.startsWith('data:') && !value.startsWith('javascript:')) {
            try {
              node.setAttribute(attr, new URL(value, location.href).href);
            } catch {}
          }
        }
      });
      if (node.hasAttribute && node.hasAttribute('srcset')) {
        const srcset = node.getAttribute('srcset');
        if (srcset) {
          const normalized = srcset
            .split(',')
            .map((part) => {
              const pieces = part.trim().split(/\\s+/);
              if (pieces.length === 0) return part;
              try {
                pieces[0] = new URL(pieces[0], location.href).href;
              } catch {}
              return pieces.join(' ');
            })
            .join(', ');
          node.setAttribute('srcset', normalized);
        }
      }
    });

    clone.querySelectorAll('meta[http-equiv=\"Content-Security-Policy\"]').forEach((node) => node.remove());

    const doctype = document.doctype
      ? '<!DOCTYPE ' + document.doctype.name
        + (document.doctype.publicId ? ' PUBLIC \"' + document.doctype.publicId + '\"' : '')
        + (document.doctype.systemId ? ' \"' + document.doctype.systemId + '\"' : '')
        + '>'
      : '<!DOCTYPE html>';

    return {
      html: doctype + '\\n' + clone.outerHTML,
      pageUrl: location.href
    };
  })()`;

  const result = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });

  return result.result.value;
}

/**
 * 将指定资源从 CDP 提取到本地目录，并递归处理 CSS 内部依赖。
 * @param {(method: string, params?: Record<string, unknown>) => Promise<any>} cdp - CDP 调用函数。
 * @param {Map<string, {frameId: string, url: string, type: string}>} resourceMap - 页面资源索引。
 * @param {string} resourceUrl - 当前要抓取的资源 URL。
 * @param {string} outputDir - 页面输出目录。
 * @param {Map<string, string>} downloaded - 已下载映射。
 * @returns {Promise<string|null>}
 */
async function downloadResource(cdp, resourceMap, resourceUrl, outputDir, downloaded) {
  if (downloaded.has(resourceUrl)) {
    return downloaded.get(resourceUrl) || null;
  }

  if (!/^https?:/i.test(resourceUrl)) {
    return null;
  }

  const resource = resourceMap.get(resourceUrl);
  if (!resource) {
    return null;
  }

  const localRelativePath = localAssetPathFor(resourceUrl, resource.type);
  downloaded.set(resourceUrl, localRelativePath);

  let result;
  try {
    result = await cdp('Page.getResourceContent', {
      frameId: resource.frameId,
      url: resource.url,
    });
  } catch (error) {
    const response = await fetch(resource.url);
    if (!response.ok) {
      throw error;
    }
    const arrayBuffer = await response.arrayBuffer();
    result = {
      content: Buffer.from(arrayBuffer).toString('base64'),
      base64Encoded: true,
    };
  }

  let contentBuffer;
  if (result.base64Encoded) {
    contentBuffer = Buffer.from(result.content, 'base64');
  } else {
    let contentText = result.content;
    if (resource.type === 'Stylesheet') {
      const nestedUrls = extractAbsoluteUrls(contentText);
      for (const nestedUrl of nestedUrls) {
        const nestedLocalPath = await downloadResource(cdp, resourceMap, nestedUrl, outputDir, downloaded);
        if (nestedLocalPath) {
          const absoluteLocal = path.posix.join(path.posix.dirname(localRelativePath), path.posix.basename(nestedLocalPath));
          contentText = contentText.split(nestedUrl).join(path.posix.relative(path.posix.dirname(localRelativePath), nestedLocalPath));
          contentText = contentText.split(absoluteLocal).join(path.posix.relative(path.posix.dirname(localRelativePath), nestedLocalPath));
        }
      }
    }
    contentBuffer = Buffer.from(contentText, 'utf8');
  }

  const targetPath = path.join(outputDir, localRelativePath);
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, contentBuffer);
  return localRelativePath;
}

/**
 * 主流程：连接目标 CDP 页面，导出 DOM、资源、MHTML 与截图。
 * @returns {Promise<void>}
 */
async function main() {
  const targetUrl = process.argv[2] || 'https://www.goofish.com/im';
  const cdpListUrl = process.argv[3] || 'http://127.0.0.1:18800/json/list';
  const outputDir = path.resolve(process.argv[4] || 'chrome_extension/public/captured/goofish-im');

  const tabs = await fetch(cdpListUrl).then((response) => response.json());
  const tab = tabs.find((item) => item.url === targetUrl && item.type === 'page');

  if (!tab?.webSocketDebuggerUrl) {
    throw new Error(`CDP 中未找到目标页面：${targetUrl}`);
  }

  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await waitForOpen(socket);
  const cdp = createCdpClient(socket);

  await cdp('Page.enable');
  await cdp('Runtime.enable');

  const domSnapshot = await getSerializedDom(cdp);
  const resourceTree = await cdp('Page.getResourceTree');
  const screenshot = await cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
  });
  const mhtml = await cdp('Page.captureSnapshot', { format: 'mhtml' });

  const resourceMap = new Map();
  collectResources(resourceTree.frameTree, resourceMap);

  const downloaded = new Map();
  const urlsInHtml = extractAbsoluteUrls(domSnapshot.html);
  for (const resourceUrl of urlsInHtml) {
    await downloadResource(cdp, resourceMap, resourceUrl, outputDir, downloaded);
  }

  const rewrittenHtml = replaceUrls(domSnapshot.html, downloaded);

  await ensureDir(outputDir);
  await fs.writeFile(path.join(outputDir, 'index.html'), rewrittenHtml, 'utf8');
  await fs.writeFile(path.join(outputDir, 'snapshot.mhtml'), mhtml.data, 'utf8');
  await fs.writeFile(path.join(outputDir, 'screenshot.png'), Buffer.from(screenshot.data, 'base64'));
  await fs.writeFile(
    path.join(outputDir, 'resources-manifest.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        pageUrl: domSnapshot.pageUrl,
        resourceCount: downloaded.size,
        resources: Object.fromEntries(downloaded),
      },
      null,
      2,
    ),
    'utf8',
  );

  socket.close();
  console.log(`Captured ${domSnapshot.pageUrl} -> ${outputDir}`);
  console.log(`Saved ${downloaded.size} resources.`);
}

await main();
