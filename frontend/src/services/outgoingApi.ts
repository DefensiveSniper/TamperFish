import { apiFetch } from './api';
import type { OutgoingMessage } from '../types/api';

export function getOutgoingMessages(
  chatKey?: string,
  status?: string,
): Promise<OutgoingMessage[]> {
  const params = new URLSearchParams();
  if (chatKey) params.set('chatKey', chatKey);
  if (status) params.set('status', status);
  const qs = params.toString();
  return apiFetch<OutgoingMessage[]>(`/api/outgoing-messages${qs ? `?${qs}` : ''}`);
}

export function postOutgoingMessage(body: {
  chatKey: string;
  sessionId?: string;
  content: string;
  source?: 'manual' | 'ai';
  customerName?: string;
  productId?: string;
}): Promise<{
  ok: boolean;
  id: number;
  source: string;
  chatKey: string;
  sessionId: string | null;
}> {
  return apiFetch('/api/outgoing-messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
