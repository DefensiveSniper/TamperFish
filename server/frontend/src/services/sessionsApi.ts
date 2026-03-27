import { apiFetch } from './api';
import type { Session, Message } from '../types/api';

export function getSessions(): Promise<Session[]> {
  return apiFetch<Session[]>('/api/sessions');
}

export function getSessionMessages(
  chatKey: string,
): Promise<{ session: Session; messages: Message[] }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(chatKey)}/messages`);
}

export function postMarkSessionRead(chatKey: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(chatKey)}/read`, { method: 'POST' });
}
