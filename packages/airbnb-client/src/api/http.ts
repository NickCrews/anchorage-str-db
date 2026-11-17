/**
 * The HTTP client for every Airbnb request.
 *
 * Airbnb sits behind Akamai, which fingerprints the TLS ClientHello and
 * refuses Node's built-in `fetch`. `impit` replays a real browser's
 * ClientHello, ALPN and header order. One instance is shared by all passes.
 */

import { Impit } from 'impit';

/** The browser to impersonate. If every request gets 403, try a newer profile. */
const BROWSER = 'chrome124';

let client: Impit | undefined;

export function http(): Impit {
  client ??= new Impit({ browser: BROWSER });
  return client;
}

/** A non-2xx response. `status` is a field so `isRateLimited` can check it. */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body = '') {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * Whether this failure is an HTTP 429. Checks the status code only, since
 * "429" can appear in listing ids and quoted response bodies, and a 429 aborts
 * the run.
 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof HttpError && err.status === 429;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** A request that throws on a non-2xx response, like `raise_for_status()`. */
export async function request(url: string, options: RequestOptions = {}): Promise<string> {
  const response = await http().fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    timeout: options.timeoutMs,
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, text);
  return text;
}

/** As `request`, parsed as JSON. */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  return JSON.parse(await request(url, options)) as T;
}
