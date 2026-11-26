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
 *   `{ action: 'pause' }`, for a service that blocks every request for a
 *   while: the rate is halved and every request waits; after `pauseMs` one
 *   request goes out as a probe. A refused probe pauses again, until the
 *   pauses reach `maxPausedMs` in all and `RateLimitedError` is thrown. A
 *   probe that succeeds lets every waiting request through.
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
  /** Halve the rate and retry after `waitMs * attempt`, or `Retry-After` when longer, up to `maxWaitMs`. */
  | { action: 'slowDown'; waitMs: number; maxWaitMs: number }
  /**
   * Halve the rate and hold every request; probe once every `pauseMs` until a
   * probe succeeds. Past `maxPausedMs` of pauses in the pacer's life, throw
   * `RateLimitedError`, ending its message with `advice`. A rate-limited
   * attempt is retried without counting against `withRetries`' attempts.
   */
  | { action: 'pause'; pauseMs: number; maxPausedMs: number; advice?: string };

/** What `withRetries` does after a failed attempt. */
export interface RetryAdvice {
  /** The least milliseconds to wait before the next attempt. */
  waitMs: number;
  /** Whether the attempt counts against the caller's attempts. */
  counts: boolean;
}

/**
 * Whether requests may go out: `open`; `paused` until `pauseMs` passes;
 * `probing`, one request out to test the block; or `closed` after
 * `maxPausedMs`, when every request throws.
 */
type Gate = 'open' | 'paused' | 'probing' | 'closed';

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
  #gate: Gate = 'open';
  #probeOut = false;
  /** When the current run of pauses began; null while open. */
  #pausedSince: number | null = null;
  /** Milliseconds paused in earlier runs of pauses. */
  #pausedBeforeMs = 0;
  #closedError: RateLimitedError | null = null;
  #gateChanged = deferred();

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

  /**
   * Resolves when this caller may send a request. Under the `pause` policy,
   * waits out a pause and throws `RateLimitedError` once the pacer is closed.
   */
  async waitTurn(): Promise<void> {
    for (;;) {
      const isProbe = await this.#passGate();
      await this.bucket.acquire();
      // A pause can begin while a caller waits on the bucket.
      if (isProbe || this.#gate === 'open') break;
    }
    this.sent += 1;
  }

  /** Waits until the gate admits this caller; true if it goes out as the probe. */
  async #passGate(): Promise<boolean> {
    for (;;) {
      if (this.#gate === 'closed') throw this.#closedError;
      if (this.#gate === 'open') return false;
      if (this.#gate === 'probing' && !this.#probeOut) {
        this.#probeOut = true;
        return true;
      }
      await this.#gateChanged.promise;
    }
  }

  #setGate(gate: Gate): void {
    this.#gate = gate;
    const changed = this.#gateChanged;
    this.#gateChanged = deferred();
    changed.resolve();
  }

  /** A successful request. */
  noteOk(): void {
    this.#consecutiveTimeouts = 0;
    if (this.#gate === 'probing') this.#reopen();
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
   * policy says and returns what the attempt loop should do next. Throws
   * `RateLimitedError` when a `pause` policy runs out of `maxPausedMs`.
   */
  noteFailure(err: unknown, attempt: number): RetryAdvice {
    const failure = this.classify(err);
    if (failure.kind !== 'rateLimited') {
      if (failure.kind === 'timeout') this.#noteTimeout();
      // A probe that failed some other way frees the slot for the next one.
      if (this.#gate === 'probing') {
        this.#probeOut = false;
        this.#setGate('probing');
      }
      return { waitMs: 0, counts: true };
    }

    this.rateLimited += 1;
    const policy = this.rateLimit;
    if (policy.action === 'slowDown') {
      this.#lower('a rate-limit response');
      const waitMs = Math.min(Math.max(policy.waitMs * attempt, failure.retryAfterMs ?? 0), policy.maxWaitMs);
      return { waitMs, counts: true };
    }
    // While paused, a refusal is from a request sent before the pause began.
    if (this.#gate !== 'paused') this.#pause(policy);
    return { waitMs: 0, counts: false };
  }

  /** Start or extend a pause, or close the pacer when the pauses are used up. */
  #pause(policy: Extract<RateLimitPolicy, { action: 'pause' }>): void {
    const now = performance.now();
    const firstRefusal = this.#gate === 'open';
    if (firstRefusal) this.#pausedSince = now;
    const pausedMs = this.#pausedBeforeMs + (now - (this.#pausedSince ?? now));
    if (pausedMs + policy.pauseMs > policy.maxPausedMs) {
      this.#closedError = new RateLimitedError(
        `${this.service} refused requests for exceeding its rate limit for ` +
          `${formatMinutes(pausedMs)}. Sent ${this.sent} requests this run, last at ` +
          `${this.bucket.rate.toFixed(2)}/s.` +
          (policy.advice ? ` ${policy.advice}` : ''),
      );
      this.#setGate('closed');
      throw this.#closedError;
    }
    if (firstRefusal) {
      this.#lower('a rate-limit response');
      log.warn(
        `${this.service} refused a request for exceeding its rate limit after ${this.sent} ` +
          `requests; pausing every request, probing every ${formatMinutes(policy.pauseMs)}`,
      );
    } else {
      log.warn(`${this.service} still refusing after ${formatMinutes(pausedMs)}; probing again`);
    }
    this.#probeOut = false;
    this.#setGate('paused');
    setTimeout(() => this.#setGate('probing'), policy.pauseMs);
  }

  /** A probe succeeded: let every waiting request through. */
  #reopen(): void {
    const pausedMs = performance.now() - (this.#pausedSince ?? performance.now());
    this.#pausedBeforeMs += pausedMs;
    this.#pausedSince = null;
    this.#probeOut = false;
    log.info(
      `${this.service} answered again after ${formatMinutes(pausedMs)}; resuming at ` +
        `${this.bucket.rate.toFixed(2)}/s`,
    );
    this.#setGate('open');
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function formatMinutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}
