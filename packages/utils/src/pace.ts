/**
 * A shared request rate for one remote service, and how that service's
 * failures change it.
 *
 * `TokenBucket` spaces requests at a fixed rate. `Pacer` wraps one with the
 * service's policy, set once where the pacer is made: `classify` sorts each
 * failure into a rate limit, a timeout or anything else, and `noteFailure`
 * acts on it.
 *
 * - **Rate limit**, under `rateLimit: { action: 'slowDown' }` (the default):
 *   the rate is halved, and the retry waits `waitMs * attempt`, or the
 *   response's `Retry-After` when longer, up to `maxWaitMs`. Under
 *   `{ action: 'abort' }`: throws `RateLimitedError`, for a service whose
 *   block outlasts the run.
 * - **Timeout:** after `timeoutBackoff` in a row, the rate is halved.
 * - **Anything else:** no change to the rate.
 *
 * The rate is never halved below `minRate`. With `recoverAfter` set, that
 * many successes in a row raise a lowered rate by a quarter, up to `rate`.
 * `withRetries` is the attempt loop that reports to a pacer.
 */

import { HttpStatusError } from './http.ts';
import { log } from './log.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** The service refused a request for exceeding its rate limit. */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/**
 * Requests per second, shared by every caller. `acquire()` resolves when the
 * caller may send. Acquisitions are served in call order.
 */
export class TokenBucket {
  #rate: number;
  readonly #burst: number;
  #tokens: number;
  #updatedMs: number;
  #turn: Promise<void> = Promise.resolve();

  constructor(rate: number, burst = 2) {
    this.#rate = Math.max(rate, 0.01);
    this.#burst = Math.max(burst, 1);
    this.#tokens = this.#burst;
    this.#updatedMs = performance.now();
  }

  get rate(): number {
    return this.#rate;
  }

  setRate(rate: number): void {
    this.#refill();
    this.#rate = Math.max(rate, 0.01);
  }

  #refill(): void {
    const now = performance.now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#updatedMs) / 1000) * this.#rate);
    this.#updatedMs = now;
  }

  acquire(): Promise<void> {
    const mine = this.#turn.then(() => this.#take());
    // Keep the chain from rejecting, or every later acquirer would reject.
    this.#turn = mine.catch(() => undefined);
    return mine;
  }

  async #take(): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await sleep(((1 - this.#tokens) / this.#rate) * 1000);
    }
  }
}

/** A failed request, as its pacer sees it. */
export type Failure =
  | { kind: 'rateLimited'; retryAfterMs: number | null }
  | { kind: 'timeout' }
  | { kind: 'other' };

/**
 * Whether this failure is a timeout. Matches the error name, which covers
 * `fetch`'s `TimeoutError` and `AbortError` and impit's `ReadTimeout`,
 * `ConnectTimeout`, `PoolTimeout` and `WriteTimeout`, rather than the
 * message, which may quote an error page.
 */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout|abort/i.test(err.name);
}

/**
 * The default `classify`: an `HttpStatusError` 429 is a rate limit, with its
 * `Retry-After`; a timeout by `isTimeout`; anything else is other. Checks the
 * status code only, since "429" can appear in ids and quoted error pages.
 */
export function classifyFailure(err: unknown): Failure {
  if (err instanceof HttpStatusError && err.status === 429) {
    return { kind: 'rateLimited', retryAfterMs: err.retryAfterMs };
  }
  return isTimeout(err) ? { kind: 'timeout' } : { kind: 'other' };
}

/** What a rate-limit response does. */
export type RateLimitPolicy =
  /** Throw `RateLimitedError`; `advice`, what the operator should do, ends its message. */
  | { action: 'abort'; advice?: string }
  /** Halve the rate and retry after `waitMs * attempt`, or `Retry-After` when longer, up to `maxWaitMs`. */
  | { action: 'slowDown'; waitMs: number; maxWaitMs: number };

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = { action: 'slowDown', waitMs: 10_000, maxWaitMs: 60_000 };

export interface PacerOptions {
  /** Requests per second, and the most `recoverAfter` raises a lowered rate to. */
  rate: number;
  /** The rate will not be halved below this. */
  minRate?: number;
  /** Consecutive timeouts before the rate is halved. */
  timeoutBackoff?: number;
  /** Consecutive successes after which a lowered rate is raised by a quarter. Unset: it stays lowered. */
  recoverAfter?: number;
  /** Sorts a failure. Default `classifyFailure`. */
  classify?: (err: unknown) => Failure;
  /** Default `DEFAULT_RATE_LIMIT_POLICY`. */
  rateLimit?: RateLimitPolicy;
  /** Names the service in log lines and the `RateLimitedError` message. */
  service?: string;
}

export class Pacer {
  readonly bucket: TokenBucket;
  readonly maxRate: number;
  readonly minRate: number;
  readonly timeoutBackoff: number;
  readonly recoverAfter: number | null;
  readonly classify: (err: unknown) => Failure;
  readonly rateLimit: RateLimitPolicy;
  readonly service: string;
  sent = 0;
  timeouts = 0;
  rateLimited = 0;
  #consecutiveTimeouts = 0;
  #consecutiveOk = 0;

  constructor(options: PacerOptions) {
    this.bucket = new TokenBucket(options.rate);
    this.maxRate = this.bucket.rate;
    this.minRate = options.minRate ?? 0.5;
    this.timeoutBackoff = options.timeoutBackoff ?? 5;
    this.recoverAfter = options.recoverAfter ?? null;
    this.classify = options.classify ?? classifyFailure;
    this.rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT_POLICY;
    this.service = options.service ?? 'the service';
  }

  /** Resolves when this caller may send a request. */
  async waitTurn(): Promise<void> {
    await this.bucket.acquire();
    this.sent += 1;
  }

  /** A successful request. */
  noteOk(): void {
    this.#consecutiveTimeouts = 0;
    if (this.recoverAfter === null) return;
    this.#consecutiveOk += 1;
    if (this.#consecutiveOk < this.recoverAfter) return;
    this.#consecutiveOk = 0;
    const current = this.bucket.rate;
    const raised = Math.min(current * 1.25, this.maxRate);
    if (raised > current) {
      this.bucket.setRate(raised);
      log.info(
        `${this.recoverAfter} consecutive successes from ${this.service}; raising the request rate ` +
          `${current.toFixed(2)}/s -> ${raised.toFixed(2)}/s`,
      );
    }
  }

  /**
   * A failed request, attempt number `attempt`. Adjusts the rate as the
   * policy says and returns the least milliseconds the service asks to wait
   * before the next attempt: 0 unless rate limited. Throws `RateLimitedError`
   * under the `abort` policy.
   */
  noteFailure(err: unknown, attempt: number): number {
    const failure = this.classify(err);
    if (failure.kind === 'timeout') {
      this.#noteTimeout();
      return 0;
    }
    if (failure.kind === 'other') return 0;

    this.rateLimited += 1;
    const policy = this.rateLimit;
    if (policy.action === 'abort') {
      throw new RateLimitedError(
        `${this.service} refused a request for exceeding its rate limit. Sent ${this.sent} ` +
          `requests this run at ${this.bucket.rate.toFixed(2)}/s.` +
          (policy.advice ? ` ${policy.advice}` : ''),
      );
    }
    this.#lower('a rate-limit response');
    return Math.min(Math.max(policy.waitMs * attempt, failure.retryAfterMs ?? 0), policy.maxWaitMs);
  }

  /** After `timeoutBackoff` in a row, halve the rate: a streak of timeouts means the limiter is stalling requests. */
  #noteTimeout(): void {
    this.timeouts += 1;
    this.#consecutiveTimeouts += 1;
    if (this.#consecutiveTimeouts < this.timeoutBackoff) return;
    this.#consecutiveTimeouts = 0;
    this.#lower(`${this.timeoutBackoff} consecutive timeouts`);
  }

  /** Halve the rate, down to `minRate`, and restart the run of successes. */
  #lower(reason: string): void {
    this.#consecutiveOk = 0;
    const current = this.bucket.rate;
    const reduced = Math.max(current / 2, this.minRate);
    if (reduced < current) {
      this.bucket.setRate(reduced);
      log.warn(
        `${reason} from ${this.service}; lowering the request rate ` +
          `${current.toFixed(2)}/s -> ${reduced.toFixed(2)}/s`,
      );
    }
  }
}
