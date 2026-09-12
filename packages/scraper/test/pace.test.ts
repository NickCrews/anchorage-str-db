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
    // N workers must take turns rather than all waking on the same token and
    // racing for it, or the pace stops meaning anything.
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

  it('always throws on a 429, naming the rate to lower', () => {
    const pacer = new Pacer({ rate: 1.8 });

    expect(() => pacer.noteRateLimited()).toThrow(RateLimitedError);
    expect(() => pacer.noteRateLimited()).toThrow(/1\.80\/s/);
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
    // One timeout is ordinary. Only a *run* of them says the limiter is
    // stalling us rather than that one request was unlucky.
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
});
