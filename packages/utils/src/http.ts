/** GET requests with Node's built-in `fetch`, for services that accept it. */

/** A non-2xx response. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
  }
}

/** GET `url` as text, throwing `HttpStatusError` on a non-2xx response and `TimeoutError` after `timeoutMs`. */
export async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new HttpStatusError(response.status, url);
  return text;
}
