import { apiFetch } from './api';
import type { Session, Message } from '../types/api';

export function getSessions(query = ''): Promise<Session[]> {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set('q', query.trim());
  }

  const suffix = params.toString();
  return apiFetch<Session[]>(suffix ? `/api/sessions?${suffix}` : '/api/sessions');
}

export function getSessionMessages(
  chatKey: string,
): Promise<{ session: Session; messages: Message[] }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(chatKey)}/messages`);
}

export function postMarkSessionRead(chatKey: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(chatKey)}/read`, { method: 'POST' });
}
