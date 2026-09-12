/**
 * One request rate shared by every pass, because Airbnb limits requests per
 * IP across all of `www.airbnb.com`.
 *
 * Airbnb's edge (Akamai) allows ~130 requests per IP in a rolling window of
 * roughly 60s, regardless of burst rate:
 *
 *     ~17 req/s  ->  refused after ~133 requests  (~8s in)
 *     ~17 req/s  ->  refused after ~130 requests  (~8s in)
 *       4 req/s  ->  stalled  after ~129 requests (~32.5s in)
 *
 * That gives a sustainable rate near 2.2/s. 1400 requests at 2.0/s ran with
 * no 429s. See docs/research/airbnb-rate-limits.md.
 *
 * Exceeding the limit has two effects:
 *
 * - **Mildly (4/s):** connections hang without a 429, so `noteTimeout` lowers
 *   the rate after a streak of timeouts.
 * - **Grossly (17/s):** every endpoint on the domain returns 429 for 1-2
 *   hours, so a 429 aborts the run (see `RateLimitedError`).
 *
 * Each pass's `*_CONCURRENCY` only caps open connections.
 */

import { REQUESTS_PER_SECOND } from './config.ts';
import { log } from './log.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Airbnb returned 429. The block is IP-wide and lasts hours, so the run stops
 * instead of retrying every remaining listing against it.
 */
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
  /** Small enough not to matter against Airbnb's ~60s window. */
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

export interface PacerOptions {
  rate?: number;
  /** The rate will not be backed off below this. */
  minRate?: number;
  /** Consecutive timeouts before the rate is halved. */
  timeoutBackoff?: number;
}

export class Pacer {
  readonly bucket: TokenBucket;
  readonly minRate: number;
  readonly timeoutBackoff: number;
  sent = 0;
  timeouts = 0;
  #consecutiveTimeouts = 0;

  constructor(options: PacerOptions = {}) {
    this.bucket = new TokenBucket(options.rate ?? REQUESTS_PER_SECOND);
    this.minRate = options.minRate ?? 0.5;
    this.timeoutBackoff = options.timeoutBackoff ?? 5;
  }

  /** Resolves when this caller may send a request. */
  async waitTurn(): Promise<void> {
    await this.bucket.acquire();
    this.sent += 1;
  }

  noteOk(): void {
    this.#consecutiveTimeouts = 0;
  }

  /** A 429. Always fatal — see `RateLimitedError`. */
  noteRateLimited(): never {
    throw new RateLimitedError(
      'Airbnb returned 429: the per-IP request limit is exhausted. The block is IP-wide ' +
        `and lasts about an hour, so the run stops. Sent ${this.sent} requests this run at ` +
        `${this.bucket.rate.toFixed(2)}/s; lower REQUESTS_PER_SECOND in config.ts.`,
    );
  }

  /**
   * Record a timed-out request. After `timeoutBackoff` in a row, halve the
   * rate, since a streak of timeouts means the limiter is stalling requests.
   */
  noteTimeout(): void {
    this.timeouts += 1;
    this.#consecutiveTimeouts += 1;
    if (this.#consecutiveTimeouts < this.timeoutBackoff) return;
    this.#consecutiveTimeouts = 0;
    const current = this.bucket.rate;
    const reduced = Math.max(current / 2, this.minRate);
    if (reduced < current) {
      this.bucket.setRate(reduced);
      log.warn(
        `${this.timeoutBackoff} consecutive timeouts; lowering the request rate ` +
          `${current.toFixed(2)}/s -> ${reduced.toFixed(2)}/s`,
      );
    }
  }
}

let pacer: Pacer | undefined;

/** The process-wide pacer, created on first use from `config`. */
export function pace(): Pacer {
  pacer ??= new Pacer();
  return pacer;
}

/** Start a fresh budget. Called once at the top of a run, and by tests. */
export function resetPace(options: PacerOptions = {}): Pacer {
  pacer = new Pacer(options);
  return pacer;
}
