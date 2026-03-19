import { apiFetch } from './api';
import type { Order, QianniuRuntime, OrderQueryParams } from '../types/api';

export function getOrders(params: OrderQueryParams = {}): Promise<Order[]> {
  const qs = new URLSearchParams();
  if (params.linked && params.linked !== 'all') qs.set('linked', params.linked);
  if (params.q) qs.set('q', params.q);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.chatKey) qs.set('chatKey', params.chatKey);
  const str = qs.toString();
  return apiFetch<Order[]>(`/api/orders${str ? `?${str}` : ''}`);
}

export function getOrdersRuntime(): Promise<QianniuRuntime> {
  return apiFetch<QianniuRuntime>('/api/orders/runtime');
}

export function postOrdersFullScan(): Promise<{
  ok: boolean;
  requestedNonce: string;
  runtime: QianniuRuntime;
}> {
  return apiFetch('/api/orders/full-scan', { method: 'POST' });
}

export function postOrdersSyncNow(): Promise<{
  ok: boolean;
  requestedNonce: string;
  runtime: QianniuRuntime;
}> {
  return apiFetch('/api/orders/sync-now', { method: 'POST' });
}
