function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isLoopbackHost(hostname: string): boolean {
  const normalizedHost = normalizeText(hostname).toLowerCase();
  return normalizedHost === '127.0.0.1' || normalizedHost === 'localhost' || normalizedHost === '::1';
}

function normalizePort(protocol: string, port: string): string {
  if (port) {
    return port;
  }

  return protocol === 'https:' ? '443' : '80';
}

function isSameOriginUrl(left: URL, right: URL): boolean {
  return left.protocol === right.protocol
    && left.hostname === right.hostname
    && normalizePort(left.protocol, left.port) === normalizePort(right.protocol, right.port);
}

export function resolveChatImageUrl(rawUrl: string | null | undefined): string {
  const normalizedUrl = normalizeText(rawUrl);
  if (!normalizedUrl || typeof window === 'undefined') {
    return normalizedUrl;
  }

  try {
    const parsedUrl = new URL(normalizedUrl, window.location.origin);
    if (!parsedUrl.pathname.startsWith('/media-cache/')) {
      return parsedUrl.toString();
    }

    return `${window.location.origin}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return normalizedUrl;
  }
}

export function isBrokenLoopbackChatImageUrl(rawUrl: string | null | undefined): boolean {
  const normalizedUrl = normalizeText(rawUrl);
  if (!normalizedUrl || typeof window === 'undefined') {
    return false;
  }

  try {
    const parsedUrl = new URL(normalizedUrl, window.location.origin);
    const currentOrigin = new URL(window.location.origin);
    return isLoopbackHost(parsedUrl.hostname)
      && parsedUrl.pathname.startsWith('/media-cache/')
      && !isSameOriginUrl(parsedUrl, currentOrigin);
  } catch {
    return false;
  }
}