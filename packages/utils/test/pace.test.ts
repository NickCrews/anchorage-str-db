import { describe, expect, it } from 'vitest';

import { Pacer, RateLimitedError, TokenBucket } from '../src/pace.ts';

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

describe('Pacer', () => {
  it('counts every request it lets through', async () => {
    const pacer = new Pacer({ rate: 1e6 });
    for (let i = 0; i < 5; i++) await pacer.waitTurn();

    expect(pacer.sent).toBe(5);
  });

  it('always throws on a rate limit, naming the service, rate and advice', () => {
    const pacer = new Pacer({ rate: 1.8, service: 'Airbnb', rateLimitAdvice: 'Lower the rate.' });

    expect(() => pacer.noteRateLimited()).toThrow(RateLimitedError);
    expect(() => pacer.noteRateLimited()).toThrow(/^Airbnb refused .* at 1\.80\/s\. Lower the rate\.$/);
  });

  it('halves the rate after a run of timeouts, and not before', () => {
    const pacer = new Pacer({ rate: 4, timeoutBackoff: 3 });

    pacer.noteTimeout();
    pacer.noteTimeout();
    expect(pacer.bucket.rate).toBe(4);

    pacer.noteTimeout();
    expect(pacer.bucket.rate).toBe(2);
  });

  it('lets a success reset the timeout streak', () => {
    const pacer = new Pacer({ rate: 4, timeoutBackoff: 3 });

    pacer.noteTimeout();
    pacer.noteTimeout();
    pacer.noteOk();
    pacer.noteTimeout();
    pacer.noteTimeout();

    expect(pacer.bucket.rate).toBe(4);
  });

  it('will not back off below its floor', () => {
    const pacer = new Pacer({ rate: 1, minRate: 0.5, timeoutBackoff: 1 });

    for (let i = 0; i < 10; i++) pacer.noteTimeout();

    expect(pacer.bucket.rate).toBe(0.5);
  });

  it('halves the rate on each throttle, down to its floor, keeping the throw-on-rate-limit path', () => {
    const pacer = new Pacer({ rate: 1, minRate: 0.25 });

    pacer.noteThrottled();
    expect(pacer.bucket.rate).toBe(0.5);
    pacer.noteThrottled();
    pacer.noteThrottled();
    expect(pacer.bucket.rate).toBe(0.25);
    expect(pacer.throttles).toBe(3);
    expect(() => pacer.noteRateLimited()).toThrow(RateLimitedError);
  });

  it('raises a lowered rate by a quarter after a run of successes, up to the starting rate', () => {
    const pacer = new Pacer({ rate: 1, minRate: 0.25, recoverAfter: 3 });
    pacer.noteThrottled();
    pacer.noteThrottled();

    pacer.noteOk();
    pacer.noteOk();
    expect(pacer.bucket.rate).toBe(0.25);
    pacer.noteOk();
    expect(pacer.bucket.rate).toBeCloseTo(0.3125);

    for (let i = 0; i < 30; i++) pacer.noteOk();
    expect(pacer.bucket.rate).toBe(1);
  });

  it('restarts the run of successes on a throttle', () => {
    const pacer = new Pacer({ rate: 1, minRate: 0.25, recoverAfter: 3 });
    pacer.noteThrottled();

    pacer.noteOk();
    pacer.noteOk();
    pacer.noteThrottled();
    pacer.noteOk();
    pacer.noteOk();

    expect(pacer.bucket.rate).toBe(0.25);
  });

  it('keeps a lowered rate without recoverAfter', () => {
    const pacer = new Pacer({ rate: 4, timeoutBackoff: 1 });
    pacer.noteTimeout();

    for (let i = 0; i < 100; i++) pacer.noteOk();

    expect(pacer.bucket.rate).toBe(2);
  });
});
