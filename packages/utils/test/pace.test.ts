import { describe, expect, it } from 'vitest';

import { HttpStatusError } from '../src/http.ts';
import { classifyFailure, isTimeout, Pacer, RateLimitedError, sleep, TokenBucket } from '../src/pace.ts';

describe('TokenBucket', () => {
  it('holds the requested rate once the burst is spent', async () => {
    const bucket = new TokenBucket(50); // 20ms apart
    const started = performance.now();
    // Burst is 2, so 6 acquisitions cost 4 refills = ~80ms.
    for (let i = 0; i < 6; i++) await bucket.acquire();
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThan(55);
    expect(elapsed).toBeLessThan(400);
  });

  it('serves concurrent acquirers in order', async () => {
    const bucket = new TokenBucket(200);
    const order: number[] = [];
    await Promise.all(
      [...Array(8).keys()].map(async (i) => {
        await bucket.acquire();
        order.push(i);
      }),
    );

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

const TIMEOUT = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

function tooManyRequests(retryAfterMs: number | null = null): HttpStatusError {
  return new HttpStatusError(429, 'https://example.test/', retryAfterMs);
}

describe('classifyFailure', () => {
  it('sorts a 429 with its Retry-After, a timeout, and anything else', () => {
    expect(classifyFailure(tooManyRequests(5_000))).toEqual({ kind: 'rateLimited', retryAfterMs: 5_000 });
    expect(classifyFailure(TIMEOUT)).toEqual({ kind: 'timeout' });
    expect(classifyFailure(new HttpStatusError(503, 'https://example.test/'))).toEqual({ kind: 'other' });
    expect(classifyFailure(new Error('no listing 4291337'))).toEqual({ kind: 'other' });
  });

  it("recognizes fetch's and impit's timeout errors by name", () => {
    const impit = new Error('read timed out');
    impit.name = 'ReadTimeout';

    expect(isTimeout(TIMEOUT)).toBe(true);
    expect(isTimeout(impit)).toBe(true);
    expect(isTimeout(new Error('timeout in the message only'))).toBe(false);
  });
});

describe('Pacer', () => {
  it('counts every request it lets through', async () => {
    const pacer = new Pacer({ rate: 1e6 });
    for (let i = 0; i < 5; i++) await pacer.waitTurn();

    expect(pacer.sent).toBe(5);
  });

  describe("under the 'pause' policy", () => {
    const pause = { action: 'pause', pauseMs: 40, maxPausedMs: 200, advice: 'Try later.' } as const;

    /** Resolves to true if `promise` settles within `ms`. */
    async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
      return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
    }

    it('halves the rate and holds every request until the pause ends', async () => {
      const pacer = new Pacer({ rate: 1e6, rateLimit: pause });

      expect(pacer.noteFailure(tooManyRequests(), 1)).toEqual({ waitMs: 0, counts: false });
      expect(pacer.bucket.rate).toBe(0.5e6);

      const started = performance.now();
      await pacer.waitTurn();
      expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    });

    it('lets one probe out, then everyone once the probe succeeds', async () => {
      const pacer = new Pacer({ rate: 1e6, rateLimit: pause });
      pacer.noteFailure(tooManyRequests(), 1);

      await pacer.waitTurn(); // the probe
      const second = pacer.waitTurn();
      expect(await settlesWithin(second, 20)).toBe(false);

      pacer.noteOk();
      expect(await settlesWithin(second, 20)).toBe(true);
      await pacer.waitTurn();
    });

    it('pauses again when the probe is refused', async () => {
      const pacer = new Pacer({ rate: 1e6, rateLimit: pause });
      pacer.noteFailure(tooManyRequests(), 1);
      await pacer.waitTurn();

      pacer.noteFailure(tooManyRequests(), 1);
      const started = performance.now();
      await pacer.waitTurn();

      expect(performance.now() - started).toBeGreaterThanOrEqual(35);
      expect(pacer.bucket.rate).toBe(0.5e6);
    });

    it('frees the probe slot when the probe fails some other way', async () => {
      const pacer = new Pacer({ rate: 1e6, rateLimit: pause });
      pacer.noteFailure(tooManyRequests(), 1);
      await pacer.waitTurn();
      const next = pacer.waitTurn();

      expect(pacer.noteFailure(new HttpStatusError(500, 'https://example.test/'), 1)).toEqual({
        waitMs: 0,
        counts: true,
      });
      expect(await settlesWithin(next, 20)).toBe(true);
    });

    it('ignores refusals of requests sent before the pause', () => {
      const pacer = new Pacer({ rate: 1e6, rateLimit: pause });
      pacer.noteFailure(tooManyRequests(), 1);
      pacer.noteFailure(tooManyRequests(), 1);
      pacer.noteFailure(tooManyRequests(), 1);

      expect(pacer.bucket.rate).toBe(0.5e6);
      expect(pacer.rateLimited).toBe(3);
    });

    it('closes once the pauses would pass maxPausedMs, failing every waiting request', async () => {
      const pacer = new Pacer({ rate: 1e6, service: 'Airbnb', rateLimit: { ...pause, maxPausedMs: 100 } });
      pacer.noteFailure(tooManyRequests(), 1);
      await pacer.waitTurn();
      pacer.noteFailure(tooManyRequests(), 1);
      await pacer.waitTurn();
      const waiting = pacer.waitTurn();

      expect(() => pacer.noteFailure(tooManyRequests(), 1)).toThrow(
        /^Airbnb refused requests .* for \d+\.\d min\. Sent 2 requests .*\. Try later\.$/,
      );
      await expect(waiting).rejects.toBeInstanceOf(RateLimitedError);
      await expect(pacer.waitTurn()).rejects.toBeInstanceOf(RateLimitedError);
    });

    it('counts pauses across blocks against maxPausedMs', async () => {
      const pacer = new Pacer({ rate: 1e6, rateLimit: { ...pause, maxPausedMs: 100 } });
      pacer.noteFailure(tooManyRequests(), 1);
      await pacer.waitTurn();
      pacer.noteOk();

      pacer.noteFailure(tooManyRequests(), 1);
      await pacer.waitTurn();

      expect(() => pacer.noteFailure(tooManyRequests(), 1)).toThrow(RateLimitedError);
    });
  });

  describe("under the 'slowDown' policy", () => {
    const slowDown = { action: 'slowDown', waitMs: 10_000, maxWaitMs: 60_000 } as const;

    it('is the default', () => {
      expect(new Pacer({ rate: 1 }).rateLimit.action).toBe('slowDown');
    });

    it('halves the rate on each rate limit, down to its floor', () => {
      const pacer = new Pacer({ rate: 1, minRate: 0.25, rateLimit: slowDown });

      pacer.noteFailure(tooManyRequests(), 1);
      expect(pacer.bucket.rate).toBe(0.5);
      pacer.noteFailure(tooManyRequests(), 1);
      pacer.noteFailure(tooManyRequests(), 1);
      expect(pacer.bucket.rate).toBe(0.25);
      expect(pacer.rateLimited).toBe(3);
    });

    it('asks for waitMs per attempt, or Retry-After when longer, up to maxWaitMs', () => {
      const pacer = new Pacer({ rate: 1, rateLimit: slowDown });

      expect(pacer.noteFailure(tooManyRequests(), 1)).toEqual({ waitMs: 10_000, counts: true });
      expect(pacer.noteFailure(tooManyRequests(), 2).waitMs).toBe(20_000);
      expect(pacer.noteFailure(tooManyRequests(30_000), 1).waitMs).toBe(30_000);
      expect(pacer.noteFailure(tooManyRequests(3_600_000), 1).waitMs).toBe(60_000);
    });
  });

  it('asks for no wait, and keeps its rate, on any other failure', () => {
    const pacer = new Pacer({ rate: 4 });

    expect(pacer.noteFailure(new HttpStatusError(500, 'https://example.test/'), 1)).toEqual({ waitMs: 0, counts: true });
    expect(pacer.bucket.rate).toBe(4);
  });

  it('uses the classifier it is given', () => {
    const pacer = new Pacer({ rate: 4, classify: () => ({ kind: 'rateLimited', retryAfterMs: null }) });

    pacer.noteFailure(new Error('anything'), 1);

    expect(pacer.bucket.rate).toBe(2);
  });

  it('halves the rate after a run of timeouts, and not before', () => {
    const pacer = new Pacer({ rate: 4, timeoutBackoff: 3 });

    pacer.noteFailure(TIMEOUT, 1);
    pacer.noteFailure(TIMEOUT, 1);
    expect(pacer.bucket.rate).toBe(4);

    expect(pacer.noteFailure(TIMEOUT, 1).waitMs).toBe(0);
    expect(pacer.bucket.rate).toBe(2);
    expect(pacer.timeouts).toBe(3);
  });

  it('lets a success reset the timeout streak', () => {
    const pacer = new Pacer({ rate: 4, timeoutBackoff: 3 });

    pacer.noteFailure(TIMEOUT, 1);
    pacer.noteFailure(TIMEOUT, 1);
    pacer.noteOk();
    pacer.noteFailure(TIMEOUT, 1);
    pacer.noteFailure(TIMEOUT, 1);

    expect(pacer.bucket.rate).toBe(4);
  });

  it('will not back off below its floor', () => {
    const pacer = new Pacer({ rate: 1, minRate: 0.5, timeoutBackoff: 1 });

    for (let i = 0; i < 10; i++) pacer.noteFailure(TIMEOUT, 1);

    expect(pacer.bucket.rate).toBe(0.5);
  });

  it('raises a lowered rate by a quarter after a run of successes, up to the starting rate', () => {
    const pacer = new Pacer({ rate: 1, minRate: 0.25, recoverAfter: 3 });
    pacer.noteFailure(tooManyRequests(), 1);
    pacer.noteFailure(tooManyRequests(), 1);

    pacer.noteOk();
    pacer.noteOk();
    expect(pacer.bucket.rate).toBe(0.25);
    pacer.noteOk();
    expect(pacer.bucket.rate).toBeCloseTo(0.3125);

    for (let i = 0; i < 30; i++) pacer.noteOk();
    expect(pacer.bucket.rate).toBe(1);
  });

  it('restarts the run of successes when the rate is lowered', () => {
    const pacer = new Pacer({ rate: 1, minRate: 0.25, recoverAfter: 3 });
    pacer.noteFailure(tooManyRequests(), 1);

    pacer.noteOk();
    pacer.noteOk();
    pacer.noteFailure(tooManyRequests(), 1);
    pacer.noteOk();
    pacer.noteOk();

    expect(pacer.bucket.rate).toBe(0.25);
  });

  it('keeps a lowered rate without recoverAfter', () => {
    const pacer = new Pacer({ rate: 4, timeoutBackoff: 1 });
    pacer.noteFailure(TIMEOUT, 1);

    for (let i = 0; i < 100; i++) pacer.noteOk();

    expect(pacer.bucket.rate).toBe(2);
  });
});
