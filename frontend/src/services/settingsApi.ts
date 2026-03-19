import { apiFetch } from './api';
import type { AppSettings } from '../types/api';

export function getSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/api/settings');
}

export function patchSettings(
  patch: Partial<Pick<AppSettings, 'autoReplyEnabled' | 'crawlerDesiredEnabled' | 'initialCrawlSessionCount'>>,
): Promise<AppSettings & { ok: boolean }> {
  return apiFetch('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function postInitialCrawl(): Promise<{ ok: boolean; requestedNonce: string }> {
  return apiFetch('/api/initial-crawl', { method: 'POST' });
}
