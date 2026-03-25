declare function GM_xmlhttpRequest(details: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  responseType?: XMLHttpRequestResponseType;
  onload?: (response: {
    status: number;
    responseText?: string;
    response?: unknown;
  }) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: () => void;
}): void;