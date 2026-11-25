/** GET requests with Node's built-in `fetch`, for services that accept it. */

/** A non-2xx response. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  /** The response's `Retry-After`, in milliseconds; null when it had none. */
  readonly retryAfterMs: number | null;

  constructor(status: number, url: string, retryAfterMs: number | null = null) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A `Retry-After` header value (delta-seconds or an HTTP date) as
 * milliseconds after `nowMs`. Null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function statusError(response: Response, url: string): HttpStatusError {
  return new HttpStatusError(response.status, url, parseRetryAfter(response.headers.get('retry-after')));
}

export interface FetchTextOptions {
  headers?: Record<string, string>;
  /** `manual` makes a redirect a non-2xx response, so it throws. Default `follow`. */
  redirect?: 'follow' | 'manual';
}

/** GET `url` as text, throwing `HttpStatusError` on a non-2xx response and `TimeoutError` after `timeoutMs`. */
export async function fetchText(url: string, timeoutMs: number, options: FetchTextOptions = {}): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: options.headers,
    redirect: options.redirect,
  });
  const text = await response.text();
  if (!response.ok) throw statusError(response, url);
  return text;
}

/**
 * GET `url` for the cookies it sets, as a `Cookie` request header value
 * (`name=value; name=value`), for a service that wants a session before it
 * answers. Attributes such as `Path` are dropped; a cookie set twice keeps
 * its last value. Throws as `fetchText` does.
 */
export async function fetchCookies(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  await response.arrayBuffer();
  if (!response.ok) throw statusError(response, url);
  const cookies = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}
