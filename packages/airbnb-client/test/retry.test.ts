/** The Airbnb pacer's policy in the attempt loop: 429s, timeouts, and other errors. */

import { beforeEach, expect, it } from 'vitest';

import { RateLimitedError } from '@anchorage-str-db/utils/pace';
import { RetriesExhaustedError, withRetries as pacedRetries, type RetryOptions } from '@anchorage-str-db/utils/retry';

import { HttpError } from '../src/api/http.ts';
import { pace, resetPace } from '../src/pace.ts';

const FAST = { label: 'test call', attempts: 4, backoffMs: 0 };

/** The attempt loop as every pass calls it, with the process-wide Airbnb pacer. */
function withRetries<T>(attempt: () => Promise<T>, options: Omit<RetryOptions, 'pacer'>): Promise<T> {
  return pacedRetries(attempt, { ...options, pacer: pace() });
}

beforeEach(() => {
  resetPace({ rate: 1e6 });
});

it('retries past a transient Airbnb 500', async () => {
  let attempts = 0;

  const result = await withRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw new HttpError(500, 'https://www.airbnb.com/', 'server error');
    return 'ok';
  }, FAST);

  expect(attempts).toBe(3);
  expect(result).toBe('ok');
});

it('throws RetriesExhaustedError with the last error as cause', async () => {
  const boom = new HttpError(503, 'https://www.airbnb.com/', 'nope');

  await expect(withRetries(async () => Promise.reject(boom), FAST)).rejects.toThrow(
    /failed after 4 attempts/,
  );
  await expect(
    withRetries(async () => Promise.reject(boom), FAST).catch((err: unknown) => {
      expect(err).toBeInstanceOf(RetriesExhaustedError);
      throw (err as Error).cause;
    }),
  ).rejects.toBe(boom);
});

it('throws RateLimitedError on the first 429 without retrying', async () => {
  let attempts = 0;

  await expect(
    withRetries(async () => {
      attempts += 1;
      throw new HttpError(429, 'https://www.airbnb.com/rooms/1');
    }, FAST),
  ).rejects.toBeInstanceOf(RateLimitedError);

  expect(attempts).toBe(1);
});

it('backs the request rate off after a run of timeouts', async () => {
  const pacer = resetPace({ rate: 1e6, timeoutBackoff: 2 });
  const before = pacer.bucket.rate;

  await expect(
    withRetries(
      async () => {
        const err = new Error('request timed out');
        err.name = 'ReadTimeout';
        throw err;
      },
      { ...FAST, attempts: 3 },
    ),
  ).rejects.toBeInstanceOf(RetriesExhaustedError);

  expect(pacer.timeouts).toBe(3);
  expect(pacer.bucket.rate).toBeLessThan(before);
});

it('treats "429" in a message or body as an ordinary error', async () => {
  const attempts: string[] = [];

  await expect(
    withRetries(async () => {
      attempts.push('x');
      throw new Error('no location data in the page for room 4291337');
    }, FAST),
  ).rejects.toBeInstanceOf(RetriesExhaustedError);

  expect(attempts).toHaveLength(4);

  await expect(
    withRetries(
      async () => Promise.reject(new HttpError(503, 'https://www.airbnb.com/', 'error 429 upstream')),
      FAST,
    ),
  ).rejects.toBeInstanceOf(RetriesExhaustedError);
});

it('counts every attempt against the run-wide budget', async () => {
  let attempts = 0;
  await withRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('flaky');
    return null;
  }, FAST);

  expect(pace().sent).toBe(3);
});
