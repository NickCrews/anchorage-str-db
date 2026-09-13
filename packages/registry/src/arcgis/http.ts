/**
 * The HTTP client for every ArcGIS request.
 *
 * Unlike Airbnb (see `packages/scraper/src/airbnb/http.ts`), an ArcGIS
 * Feature Service is a documented, public, unauthenticated REST API with no
 * bot protection, so Node's built-in `fetch` is enough and this package needs
 * no `impit`.
 *
 * Two ArcGIS quirks shape this file:
 *
 * - **Errors arrive as HTTP 200.** A bad layer, an invalid `where`, or a
 *   token requirement is reported as `{"error":{"code":400,...}}` in a 200
 *   response body. `requestJson` raises those as `ArcGisError` so a caller
 *   never parses an error object as data.
 * - **Long queries must be POSTed.** A `where` clause listing a few thousand
 *   object ids exceeds what servers accept in a URL, so parameters go in a
 *   form-encoded body.
 */

import { REQUEST_TIMEOUT_MS, USER_AGENT } from '../config.ts';

/** A non-2xx response. */
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

/** An `{"error": ...}` object returned with HTTP 200. */
export class ArcGisError extends Error {
  readonly code: number;
  readonly url: string;

  constructor(code: number, message: string, url: string, details: readonly string[] = []) {
    super(`ArcGIS error ${code} for ${url}: ${message}${details.length ? ` (${details.join('; ')})` : ''}`);
    this.name = 'ArcGisError';
    this.code = code;
    this.url = url;
  }
}

/** The shape ArcGIS uses for an error returned with HTTP 200. */
interface ErrorEnvelope {
  error?: { code?: number; message?: string; details?: string[] };
}

/**
 * POST `params` as a form body and parse the JSON response.
 *
 * Always POST: a GET of the same query is capped by the server's URL length,
 * which `queryByObjectIds` exceeds routinely.
 */
export async function requestJson<T>(url: string, params: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ f: 'json', ...params }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML error page or a redirect to a sign-in form.
    throw new ArcGisError(0, `response was not JSON: ${text.slice(0, 200)}`, url);
  }

  const envelope = parsed as ErrorEnvelope;
  if (envelope.error) {
    throw new ArcGisError(
      envelope.error.code ?? 0,
      envelope.error.message ?? 'unknown error',
      url,
      envelope.error.details ?? [],
    );
  }
  return parsed as T;
}
