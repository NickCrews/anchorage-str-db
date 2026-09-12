/**
 * The attempt loop shared by every Airbnb request.
 *
 * Each attempt waits for the pacer, then on failure:
 *
 * - **429:** throws `RateLimitedError` immediately (see `pace.ts`).
 * - **Timeout:** reported to `noteTimeout`, which lowers the rate after a
 *   streak, then retried.
 * - **Anything else:** retried with linear backoff.
 *
 * Callers decide what exhausted retries mean: the search fails the run, and
 * per-listing passes record the error.
 */

import { isRateLimited, isTimeout } from './airbnb/http.ts';
import { pace, sleep } from './pace.ts';

export class RetriesExhaustedError extends Error {
  readonly attempts: number;

  constructor(label: string, attempts: number, cause: unknown) {
    super(`${label} failed after ${attempts} attempts`, { cause });
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
  }
}

export interface RetryOptions {
  label: string;
  attempts: number;
  backoffMs: number;
  /** Called before each retry, with the error that prompted it. */
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Run `attempt`, paced and retried. Throws `RetriesExhaustedError` when
 * every attempt failed, or `RateLimitedError` the moment Airbnb says 429.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const pacer = pace();
  let lastError: unknown;
  for (let n = 1; n <= options.attempts; n++) {
    await pacer.waitTurn();
    try {
      const result = await attempt();
      pacer.noteOk();
      return result;
    } catch (err) {
      if (isRateLimited(err)) pacer.noteRateLimited(); // throws
      if (isTimeout(err)) pacer.noteTimeout();
      lastError = err;
      if (n < options.attempts) {
        options.onRetry?.(err, n);
        await sleep(options.backoffMs * n);
      }
    }
  }
  throw new RetriesExhaustedError(options.label, options.attempts, lastError);
}
