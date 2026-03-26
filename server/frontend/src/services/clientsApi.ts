import { apiFetch } from './api';
import type { Client, QianniuRuntime, AppSettings } from '../types/api';

export function getClients(): Promise<Client[]> {
  return apiFetch<Client[]>('/api/clients');
}

export function getClientRuntime(clientId: string): Promise<{
  settings: AppSettings;
  qianniu: QianniuRuntime;
  client: Client;
}> {
  return apiFetch(`/api/clients/${encodeURIComponent(clientId)}/runtime`);
}

export function postClientInitialCrawl(clientId: string): Promise<{
  ok: boolean;
  requestedNonce: string;
}> {
  return apiFetch(`/api/clients/${encodeURIComponent(clientId)}/initial-crawl`, { method: 'POST' });
}

export function postClientOrdersSyncNow(clientId: string): Promise<{
  ok: boolean;
  requestedNonce: string;
  runtime: QianniuRuntime;
}> {
  return apiFetch(`/api/clients/${encodeURIComponent(clientId)}/orders/sync-now`, { method: 'POST' });
}

export function postClientOrdersFullScan(clientId: string): Promise<{
  ok: boolean;
  requestedNonce: string;
  runtime: QianniuRuntime;
}> {
  return apiFetch(`/api/clients/${encodeURIComponent(clientId)}/orders/full-scan`, { method: 'POST' });
}
