let _accountId = 'default';
let _clientId = 'legacy-client-1';

export function setActiveAccountId(accountId: string) {
  _accountId = accountId;
}

export function getActiveAccountId(): string {
  return _accountId;
}

export function setActiveClientId(clientId: string) {
  _clientId = clientId;
}

export function getActiveClientId(): string {
  return _clientId;
}

export async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Account-Id': _accountId,
    'X-Client-Id': _clientId,
    ...opts?.headers as Record<string, string>,
  };

  const response = await fetch(url, {
    ...opts,
    headers,
  });
  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = '/login';
      throw new Error('unauthorized');
    }
    const body = await response.text();
    let message: string;
    try {
      message = JSON.parse(body).error || `HTTP ${response.status}`;
    } catch {
      message = body || `HTTP ${response.status}`;
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
