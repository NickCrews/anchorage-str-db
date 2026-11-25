import { expect, it } from 'vitest';

import { HttpStatusError, parseRetryAfter } from '../src/http.ts';
import { Pacer, RateLimitedError } from '../src/pace.ts';
import { isTimeout, RetriesExhaustedError, withRetries } from '../src/retry.ts';

class StatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

function options(pacer = new Pacer({ rate: 1e6 })) {
  return { label: 'test call', attempts: 4, backoffMs: 0, pacer };
}

it('retries past transient failures and counts every attempt against the pacer', async () => {
  const pacer = new Pacer({ rate: 1e6 });
  let attempts = 0;

  const result = await withRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw new StatusError(500);
    return 'ok';
  }, options(pacer));

  expect(result).toBe('ok');
  expect(pacer.sent).toBe(3);
});

it('throws RetriesExhaustedError with the last error as cause', async () => {
  const boom = new StatusError(503);

  const err = await withRetries(async () => Promise.reject(boom), options()).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(RetriesExhaustedError);
  expect((err as Error).message).toMatch(/test call failed after 4 attempts/);
  expect((err as Error).cause).toBe(boom);
});

it('throws RateLimitedError on the first failure the caller calls a rate limit', async () => {
  let attempts = 0;

  await expect(
    withRetries(
      async () => {
        attempts += 1;
        throw new StatusError(429);
      },
      { ...options(), isRateLimited: (e) => e instanceof StatusError && e.status === 429 },
    ),
  ).rejects.toBeInstanceOf(RateLimitedError);
  expect(attempts).toBe(1);
});

it('retries a 429 when no rate-limit predicate is given', async () => {
  await expect(
    withRetries(async () => Promise.reject(new StatusError(429)), options()),
  ).rejects.toBeInstanceOf(RetriesExhaustedError);
});

function rateLimited(retryAfterMs: number | null = null): HttpStatusError {
  return new HttpStatusError(429, 'https://example.test/', retryAfterMs);
}

const slowDown = {
  isRateLimited: (e: unknown) => e instanceof HttpStatusError && e.status === 429,
  rateLimitBackoff: { waitMs: 1, maxWaitMs: 1_000 },
};

it('with rateLimitBackoff, slows the pacer on a rate limit and retries', async () => {
  const pacer = new Pacer({ rate: 1e6, minRate: 1 });
  let attempts = 0;

  const result = await withRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) throw rateLimited();
      return 'ok';
    },
    { ...options(pacer), ...slowDown },
  );

  expect(result).toBe('ok');
  expect(pacer.throttles).toBe(2);
  expect(pacer.bucket.rate).toBe(0.25e6);
});

it('with rateLimitBackoff, throws RetriesExhaustedError once every attempt was rate limited', async () => {
  const err = await withRetries(async () => Promise.reject(rateLimited()), {
    ...options(),
    ...slowDown,
  }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(RetriesExhaustedError);
  expect(((err as Error).cause as HttpStatusError).status).toBe(429);
});

it("waits for a rate-limited response's Retry-After before retrying", async () => {
  let attempts = 0;
  const started = performance.now();

  await withRetries(
    async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimited(80);
      return 'ok';
    },
    { ...options(), ...slowDown },
  );

  expect(performance.now() - started).toBeGreaterThanOrEqual(75);
});

it('caps the wait at maxWaitMs, whatever Retry-After asks for', async () => {
  let attempts = 0;
  const started = performance.now();

  await withRetries(
    async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimited(3_600_000);
      return 'ok';
    },
    { ...options(), ...slowDown, rateLimitBackoff: { waitMs: 1, maxWaitMs: 20 } },
  );

  expect(performance.now() - started).toBeLessThan(1_000);
});

it('reads Retry-After as seconds or an HTTP date', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');

  expect(parseRetryAfter('30', now)).toBe(30_000);
  expect(parseRetryAfter('Wed, 25 Nov 2026 12:00:05 GMT', now)).toBe(5_000);
  expect(parseRetryAfter('Wed, 25 Nov 2026 11:00:00 GMT', now)).toBe(0);
  expect(parseRetryAfter(null, now)).toBeNull();
  expect(parseRetryAfter('soon', now)).toBeNull();
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

it("recognizes fetch's and impit's timeout errors by name", () => {
  const impit = new Error('read timed out');
  impit.name = 'ReadTimeout';

  expect(isTimeout(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  expect(isTimeout(impit)).toBe(true);
  expect(isTimeout(new Error('timeout in the message only'))).toBe(false);
});
