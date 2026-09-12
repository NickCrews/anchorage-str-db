/**
 * One attempt loop, shared by the three passes that talk to Airbnb.
 *
 * All three want the same thing: wait for the run's request budget, try,
 * and on failure decide between three very different kinds of error.
 *
 * - **429 is fatal, immediately.** `noteRateLimited` throws, and that
 *   exception has to leave this loop rather than be caught and retried.
 *   Retrying is precisely the behaviour that turns one 429 into thousands
 *   of them against a block that lasts on the order of an hour.
 * - **A timeout is a warning, not bad luck.** Mild overage stalls
 *   connections rather than refusing them, so a run of them is the only
 *   notice we get before the expensive failure; `noteTimeout` backs the
 *   rate off.
 * - **Anything else is Airbnb's ordinary intermittent 5xx**, which succeeds
 *   on the next attempt often enough to be worth waiting for.
 *
 * What the passes *don't* share is what exhaustion means, so that is the
 * caller's to decide: a failed search page costs the whole run and throws,
 * a failed listing page or calendar costs one listing and is recorded.
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
      if (isRateLimited(err)) pacer.noteRateLimited(); // throws; aborts the run
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
