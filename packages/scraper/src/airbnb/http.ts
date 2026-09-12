/**
 * The one HTTP client every Airbnb request in a run goes through.
 *
 * Airbnb sits behind Akamai, which fingerprints the TLS ClientHello. Node's
 * built-in `fetch` announces itself as Node no matter what `User-Agent`
 * header you set, and is refused. `impit` is a Rust client that replays a
 * real browser's ClientHello, ALPN and header order.
 *
 * One instance per process, shared by the search, the page pass and the
 * calendar pass, so they also share a connection pool. That mirrors how
 * Airbnb counts us: one per-IP budget for the lot (see `pace.ts`).
 */

import { Impit } from 'impit';

/**
 * The browser to impersonate. Airbnb accepts this profile today; if requests
 * start failing wholesale with a 403, a newer one is the first thing to try,
 * since a profile eventually ages out of plausibility.
 */
const BROWSER = 'chrome124';

let client: Impit | undefined;

export function http(): Impit {
  client ??= new Impit({ browser: BROWSER });
  return client;
}

/**
 * A non-2xx response.
 *
 * Carries `status` as a field rather than only in the message, because the
 * one status this project reacts to — 429 — must be recognised
 * structurally. See `isRateLimited`.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, body?: string) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * Did this failure come back 429?
 *
 * Structural only — the status code, never the text. A 429 aborts the entire
 * run, so a false positive is expensive, and every plausible textual test has
 * one: `"429"` appears in the room id of listing 4291337, and in any error
 * message that quotes a response body. Every request in this package goes
 * through `request`, which raises `HttpError` carrying the real status, so
 * there is nothing a substring match would catch that this does not.
 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof HttpError && err.status === 429;
}

/**
 * Did this request hang rather than fail?
 *
 * A hung request is the limiter's quiet warning, not bad luck: mild overage
 * stalls connections rather than refusing them (see `pace.ts`). impit raises
 * a family of `*Timeout` errors — `ReadTimeout`, `ConnectTimeout`,
 * `PoolTimeout`, `WriteTimeout` — so the error's *name* covers all of them,
 * and an `AbortError` besides. Matching the message instead would fire on
 * any Airbnb error page that happens to say "timed out".
 */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout|abort/i.test(err.name);
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
