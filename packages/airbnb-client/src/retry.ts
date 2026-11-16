/**
 * `withRetries` for Airbnb requests: paced by the shared Airbnb pacer, with an
 * HTTP 429 treated as the IP-wide rate limit (see `pace.ts`).
 *
 * Callers decide what exhausted retries mean: the search fails the run, and
 * per-listing passes record the error.
 */

import { withRetries as pacedRetries, type RetryOptions } from '@anchorage-str-db/utils/retry';

import { isRateLimited } from './api/http.ts';
import { pace } from './pace.ts';

export { RetriesExhaustedError } from '@anchorage-str-db/utils/retry';

/** Backoff between retries of a failed fetch: `RETRY_BACKOFF_MS * attempt`. */
export const RETRY_BACKOFF_MS = 500;

export function withRetries<T>(
  attempt: () => Promise<T>,
  options: Omit<RetryOptions, 'pacer' | 'isRateLimited'>,
): Promise<T> {
  return pacedRetries(attempt, { ...options, pacer: pace(), isRateLimited });
}
