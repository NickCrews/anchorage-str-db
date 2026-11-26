/**
 * A paced attempt loop. Each attempt waits for the pacer; a failure is
 * reported to `Pacer.noteFailure`, which applies the service's policy (see
 * `pace.ts`), then retried after `backoffMs * attempt`, or longer when the
 * service asks. An attempt refused under a `pause` policy is retried after
 * the pause without counting. Callers decide what exhausted retries mean.
 */

import { sleep, type Pacer } from './pace.ts';

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
  pacer: Pacer;
  /** Called before each retry, with the error that prompted it. */
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Run `attempt`, paced and retried. Throws `RetriesExhaustedError` when
 * every attempt failed, or `RateLimitedError` when the pacer's `pause`
 * policy gives up on a rate limit.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { pacer } = options;
  let lastError: unknown;
  for (let n = 1; n <= options.attempts; ) {
    await pacer.waitTurn();
    try {
      const result = await attempt();
      pacer.noteOk();
      return result;
    } catch (err) {
      const advice = pacer.noteFailure(err, n);
      lastError = err;
      // An attempt the pacer paused for is retried once the pause lifts.
      if (!advice.counts) continue;
      if (n < options.attempts) {
        options.onRetry?.(err, n);
        await sleep(Math.max(options.backoffMs * n, advice.waitMs));
      }
      n += 1;
    }
  }
  throw new RetriesExhaustedError(options.label, options.attempts, lastError);
}
