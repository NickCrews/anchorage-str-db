/**
 * A shared request rate for one remote service.
 *
 * `TokenBucket` spaces requests at a fixed rate. `Pacer` wraps one and reacts
 * to the service's signals: a streak of timeouts halves the rate, and a
 * rate-limit response throws `RateLimitedError`. The caller decides what a
 * rate-limit response is (see `withRetries`).
 */

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

export interface PacerOptions {
  /** Requests per second. */
  rate: number;
  /** The rate will not be backed off below this. */
  minRate?: number;
  /** Consecutive timeouts before the rate is halved. */
  timeoutBackoff?: number;
  /** Names the service in the `RateLimitedError` message. */
  service?: string;
  /** Appended to the `RateLimitedError` message: what the operator should do. */
  rateLimitAdvice?: string;
}

export class Pacer {
  readonly bucket: TokenBucket;
  readonly minRate: number;
  readonly timeoutBackoff: number;
  readonly service: string;
  readonly rateLimitAdvice: string;
  sent = 0;
  timeouts = 0;
  #consecutiveTimeouts = 0;

  constructor(options: PacerOptions) {
    this.bucket = new TokenBucket(options.rate);
    this.minRate = options.minRate ?? 0.5;
    this.timeoutBackoff = options.timeoutBackoff ?? 5;
    this.service = options.service ?? 'the service';
    this.rateLimitAdvice = options.rateLimitAdvice ?? '';
  }

  /** Resolves when this caller may send a request. */
  async waitTurn(): Promise<void> {
    await this.bucket.acquire();
    this.sent += 1;
  }

  noteOk(): void {
    this.#consecutiveTimeouts = 0;
  }

  /** A rate-limit response. Always throws `RateLimitedError`. */
  noteRateLimited(): never {
    throw new RateLimitedError(
      `${this.service} refused a request for exceeding its rate limit. Sent ${this.sent} ` +
        `requests this run at ${this.bucket.rate.toFixed(2)}/s.` +
        (this.rateLimitAdvice ? ` ${this.rateLimitAdvice}` : ''),
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
        `${this.timeoutBackoff} consecutive timeouts from ${this.service}; lowering the request rate ` +
          `${current.toFixed(2)}/s -> ${reduced.toFixed(2)}/s`,
      );
    }
  }
}
