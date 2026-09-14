import { expect, it } from 'vitest';

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
