import { expect, it } from 'vitest';

import { HttpStatusError } from '../src/http.ts';
import { Pacer, RateLimitedError } from '../src/pace.ts';
import { RetriesExhaustedError, withRetries } from '../src/retry.ts';

function failure(status: number, retryAfterMs: number | null = null): HttpStatusError {
  return new HttpStatusError(status, 'https://example.test/', retryAfterMs);
}

/** A pacer that never makes a test wait, rate limits included. */
function fastPacer(): Pacer {
  return new Pacer({ rate: 1e6, minRate: 1, rateLimit: { action: 'slowDown', waitMs: 1, maxWaitMs: 1_000 } });
}

function options(pacer = fastPacer()) {
  return { label: 'test call', attempts: 4, backoffMs: 0, pacer };
}

it('retries past transient failures and counts every attempt against the pacer', async () => {
  const pacer = fastPacer();
  let attempts = 0;

  const result = await withRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw failure(500);
    return 'ok';
  }, options(pacer));

  expect(result).toBe('ok');
  expect(pacer.sent).toBe(3);
});

it('throws RetriesExhaustedError with the last error as cause', async () => {
  const boom = failure(503);

  const err = await withRetries(async () => Promise.reject(boom), options()).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(RetriesExhaustedError);
  expect((err as Error).message).toMatch(/test call failed after 4 attempts/);
  expect((err as Error).cause).toBe(boom);
});

it("retries a rate limit after the pause without counting it under the 'pause' policy", async () => {
  const pacer = new Pacer({ rate: 1e6, rateLimit: { action: 'pause', pauseMs: 5, maxPausedMs: 1_000 } });
  let calls = 0;

  const result = await withRetries(async () => {
    calls += 1;
    if (calls <= 3) throw failure(429);
    return 'ok';
  }, { ...options(pacer), attempts: 1 });

  expect(result).toBe('ok');
  expect(calls).toBe(4);
});

it("throws RateLimitedError once the 'pause' policy runs out of pauses", async () => {
  const pacer = new Pacer({ rate: 1e6, rateLimit: { action: 'pause', pauseMs: 5, maxPausedMs: 20 } });

  await expect(withRetries(async () => Promise.reject(failure(429)), options(pacer))).rejects.toBeInstanceOf(
    RateLimitedError,
  );
});

it("slows the pacer on a rate limit and retries under its 'slowDown' policy", async () => {
  const pacer = fastPacer();
  let attempts = 0;

  const result = await withRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw failure(429);
    return 'ok';
  }, options(pacer));

  expect(result).toBe('ok');
  expect(pacer.rateLimited).toBe(2);
  expect(pacer.bucket.rate).toBe(0.25e6);
});

it('throws RetriesExhaustedError once every attempt was rate limited', async () => {
  const err = await withRetries(async () => Promise.reject(failure(429)), options()).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(RetriesExhaustedError);
  expect(((err as Error).cause as HttpStatusError).status).toBe(429);
});

it('waits as long as the pacer asks before retrying a rate limit', async () => {
  let attempts = 0;
  const started = performance.now();

  await withRetries(async () => {
    attempts += 1;
    if (attempts === 1) throw failure(429, 80);
    return 'ok';
  }, options());

  expect(performance.now() - started).toBeGreaterThanOrEqual(75);
});

it('backs the request rate off after a run of timeouts', async () => {
  const pacer = new Pacer({ rate: 1e6, timeoutBackoff: 2 });

  await expect(
    withRetries(
      async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      { ...options(pacer), attempts: 3 },
    ),
  ).rejects.toBeInstanceOf(RetriesExhaustedError);

  expect(pacer.timeouts).toBe(3);
  expect(pacer.bucket.rate).toBeLessThan(1e6);
});
