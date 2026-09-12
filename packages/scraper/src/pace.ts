/**
 * One request budget for the whole run, because Airbnb keeps one for us.
 *
 * ## What was measured
 *
 * Airbnb (really Akamai, in front of it) counts *requests per IP over a
 * rolling window* and stops caring how fast you got there. Three separate
 * trips, all against `www.airbnb.com/rooms/`:
 *
 *     ~17 req/s  ->  refused after ~133 requests  (~8s in)
 *     ~17 req/s  ->  refused after ~130 requests  (~8s in)
 *       4 req/s  ->  stalled  after ~129 requests (~32.5s in)
 *
 * A stable count across a 4x spread in elapsed time is the signature of a
 * request counter, not a rate limiter. The threshold is ~130. The window is
 * longer than 32.5s (the 4/s trip proves it) and shorter than ~104s
 * (sustained runs at 1.25/s never tripped), so ~60s fits every observation
 * and puts the sustainable rate near **2.2/s**.
 *
 * Measured directly: 1400 requests at a held 2.0/s ran 11.7 minutes with
 * zero 429s. That is the calibration `config.REQUESTS_PER_SECOND` is set
 * from.
 *
 * ## There are two different punishments
 *
 * **Mild overage stalls you.** At 4/s the limiter stopped answering rather
 * than refusing: connections hung until every worker sat in a timeout and
 * throughput sagged to ~1.8/s, without a single 429. Nothing in a success
 * count can see that — it looks like Airbnb got slow. It shows up as rising
 * latency, which is why `noteTimeout` treats a run of timeouts as a signal
 * to back off rather than as bad luck.
 *
 * **Gross overage bans you for hours.** The 17/s burst earned a block that
 * was still refusing 32.6 minutes later and cleared somewhere around 70
 * minutes after that — call it 1-2 hours, IP-wide. While it lasts
 * *everything* on `www.airbnb.com` is refused: the homepage, the PDP, and
 * the GraphQL calendar endpoint alike. That is why the budget here is
 * global rather than per-pass, and why a 429 aborts the run instead of
 * retrying (see `RateLimitedError`).
 *
 * ## Why one budget and not one per pass
 *
 * The search, the page pass and the calendar pass draw on a single per-IP
 * counter whether the code models it that way or not. The rate is one
 * number in requests per second shared by all three; each pass's
 * `*_CONCURRENCY` is only a cap on how many sockets may be open at once.
 */

import { REQUESTS_PER_SECOND } from './config.ts';
import { log } from './log.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Airbnb returned 429. The run should stop, not retry.
 *
 * Retrying looks like resilience and is the opposite here: three attempts
 * with a half-second backoff spend 1.5 seconds against a block measured in
 * *hours*. All three fail, the listing is recorded as a failed fetch, and the
 * next listing begins the same doomed sequence — 2600 times, while still
 * knocking on an endpoint that is refusing us and may well be counting the
 * refusals.
 *
 * Stopping at the first 429 keeps a clear error naming the real cause, and
 * an IP that is not being hammered while it is trying to cool off.
 */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/**
 * Requests per second, shared by every caller. `acquire()` resolves when the
 * caller may send.
 *
 * Acquisitions are served strictly in order: each one chains onto the last,
 * so N concurrent workers take turns rather than all waking on the same
 * token and racing for it.
 */
export class TokenBucket {
  #rate: number;
  /** A small burst absorbs ordinary jitter without meaningfully moving the
   * rolling-window count Airbnb is actually keeping. */
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
    // The chain must never reject, or every later acquirer inherits it.
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
      'Airbnb returned 429: the per-IP request budget is exhausted. Measured, this block ' +
        'is IP-wide and lasts on the order of an hour, so the run stops here rather than ' +
        `retrying. Sent ${this.sent} requests this run at ` +
        `${this.bucket.rate.toFixed(2)}/s; lower REQUESTS_PER_SECOND in config.ts.`,
    );
  }

  /**
   * A hung request — possibly the limiter stalling us rather than refusing.
   *
   * One timeout is ordinary. A run of them is how mild overage presented in
   * testing: at 4/s no 429 ever arrived, the connections simply stopped
   * answering. Halving the rate here is the cheap response to the only
   * warning we get before the expensive failure.
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
        `${this.timeoutBackoff} consecutive timeouts — Airbnb may be throttling rather than ` +
          `refusing; dropping the request rate ${current.toFixed(2)}/s -> ${reduced.toFixed(2)}/s`,
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
