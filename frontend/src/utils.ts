// HTML escape
export function esc(t: unknown): string {
  return String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Safe JSON parse
export function tryParse<T = unknown>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// Format unix timestamp
export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '\u2014';
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', { hour12: false });
}

// Time ago
export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return '\u521a\u521a';
  if (diff < 3600) return `${Math.floor(diff / 60)}\u5206\u949f\u524d`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}\u5c0f\u65f6\u524d`;
  return `${Math.floor(diff / 86400)}\u5929\u524d`;
}
