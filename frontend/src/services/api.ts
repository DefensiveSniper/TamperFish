export async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers as Record<string, string> },
    ...opts,
  });
  if (!response.ok) {
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
