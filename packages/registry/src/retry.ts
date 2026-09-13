/**
 * The attempt loop shared by every ArcGIS request.
 *
 * Simpler than the scraper's: there is no pacer, because a whole run is a
 * handful of requests against a public municipal endpoint rather than eight
 * thousand against a hostile one. A deterministic failure (a 400 from a bad
 * field name, a 403 from a layer that wants a token) is not retried — see
 * `isRetryable`.
 */

import { ArcGisError, HttpError } from './arcgis/http.ts';
import { IncompleteResponseError } from './arcgis/query.ts';
import { MAX_RETRIES, RETRY_BACKOFF_MS } from './config.ts';
import { describeError, log, rootCause } from './log.ts';

/**
 * Whether a failure is worth retrying.
 *
 * ArcGIS answers an overloaded query with 500/502/503/504 or a timeout, all
 * of which usually succeed on a later attempt. Three failures will recur
 * identically and are not retried: a 400 (a bad `where` or an unknown
 * field), a 403 (the layer wants a token), and a truncated response, which
 * `extract.ts` answers by asking for fewer records rather than by asking
 * again for the same ones.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof IncompleteResponseError) return false;
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof ArcGisError) return err.code >= 500;
  // Timeouts and connection resets reach us as TypeError/AbortError.
  return err instanceof Error;
}

export class RetriesExhaustedError extends Error {
  readonly attempts: number;

  constructor(label: string, attempts: number, cause: unknown) {
    super(`${label} failed after ${attempts} attempts: ${describeError(rootCause(cause))}`, {
      cause,
    });
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `attempt`, retrying retryable failures with linear backoff. Rethrows a
 * non-retryable failure as it was raised, so the run log names the real
 * cause rather than "failed after 4 attempts".
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  label: string,
  attempts: number = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let n = 1; n <= attempts; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      lastError = err;
      if (n < attempts) {
        log.warn(`${label}: attempt ${n} failed (${describeError(err)}), retrying`);
        await sleep(RETRY_BACKOFF_MS * n);
      }
    }
  }
  throw new RetriesExhaustedError(label, attempts, lastError);
}
