/**
 * A paced attempt loop.
 *
 * Each attempt waits for the pacer, then on failure:
 *
 * - **Rate limited** (`isRateLimited`): without `rateLimitBackoff`, throws
 *   `RateLimitedError` immediately via `Pacer.noteRateLimited`. With it,
 *   reported to `Pacer.noteThrottled`, which halves the rate, then retried
 *   after `rateLimitBackoff.waitMs * attempt`, or the response's
 *   `Retry-After` when longer, capped at `rateLimitBackoff.maxWaitMs`.
 * - **Timeout** (`isTimeout`): reported to `Pacer.noteTimeout`, which lowers
 *   the rate after a streak, then retried.
 * - **Anything else:** retried with linear backoff.
 *
 * Callers decide what exhausted retries mean.
 */

import { HttpStatusError } from './http.ts';
import { sleep, type Pacer } from './pace.ts';

export class RetriesExhaustedError extends Error {
  readonly attempts: number;

  constructor(label: string, attempts: number, cause: unknown) {
    super(`${label} failed after ${attempts} attempts`, { cause });
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
  }
}

/**
 * Whether this failure is a timeout. Matches the error name, which covers
 * `fetch`'s `TimeoutError` and `AbortError` and impit's `ReadTimeout`,
 * `ConnectTimeout`, `PoolTimeout` and `WriteTimeout`, rather than the
 * message, which may quote an error page.
 */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout|abort/i.test(err.name);
}

/** How long to wait before retrying a rate-limited attempt. */
export interface RateLimitBackoff {
  /** Wait before retry n: `waitMs * n`. */
  waitMs: number;
  /** The longest wait, whatever `Retry-After` asks for. */
  maxWaitMs: number;
}

export interface RetryOptions {
  label: string;
  attempts: number;
  backoffMs: number;
  pacer: Pacer;
  /** Whether a failure is the service's rate limit. Default: never. */
  isRateLimited?: (err: unknown) => boolean;
  /** Set: a rate-limited attempt slows the pacer and is retried. Unset: it throws `RateLimitedError`. */
  rateLimitBackoff?: RateLimitBackoff;
  /** Whether a failure is a timeout. Default: `isTimeout`. */
  isTimeout?: (err: unknown) => boolean;
  /** Called before each retry, with the error that prompted it. */
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Run `attempt`, paced and retried. Throws `RetriesExhaustedError` when
 * every attempt failed, or, without `rateLimitBackoff`, `RateLimitedError` on
 * the first rate-limited one.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { pacer } = options;
  const rateLimited = options.isRateLimited ?? (() => false);
  const timedOut = options.isTimeout ?? isTimeout;
  let lastError: unknown;
  for (let n = 1; n <= options.attempts; n++) {
    await pacer.waitTurn();
    try {
      const result = await attempt();
      pacer.noteOk();
      return result;
    } catch (err) {
      let waitMs = options.backoffMs * n;
      if (rateLimited(err)) {
        const backoff = options.rateLimitBackoff;
        if (!backoff) return pacer.noteRateLimited(); // throws
        pacer.noteThrottled();
        waitMs = rateLimitWaitMs(err, n, backoff);
      } else if (timedOut(err)) {
        pacer.noteTimeout();
      }
      lastError = err;
      if (n < options.attempts) {
        options.onRetry?.(err, n);
        await sleep(waitMs);
      }
    }
  }
  throw new RetriesExhaustedError(options.label, options.attempts, lastError);
}

/** The wait before retry `attempt` after a rate-limited failure `err`. */
function rateLimitWaitMs(err: unknown, attempt: number, backoff: RateLimitBackoff): number {
  const retryAfterMs = err instanceof HttpStatusError ? (err.retryAfterMs ?? 0) : 0;
  return Math.min(Math.max(backoff.waitMs * attempt, retryAfterMs), backoff.maxWaitMs);
}
