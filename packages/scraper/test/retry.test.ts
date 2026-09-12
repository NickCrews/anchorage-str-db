/**
 * The attempt loop, and the three kinds of failure it must tell apart.
 */

import { beforeEach, expect, it } from 'vitest';

import { HttpError } from '../src/airbnb/http.ts';
import { pace, RateLimitedError, resetPace } from '../src/pace.ts';
import { RetriesExhaustedError, withRetries } from '../src/retry.ts';

const FAST = { label: 'test call', attempts: 4, backoffMs: 0 };

beforeEach(() => {
  resetPace({ rate: 1e6 });
});

it('retries past a transient Airbnb 500', async () => {
  // Airbnb returns an occasional 500 that succeeds on the next attempt. A
  // failed search page costs the entire pass — there is no
  // partial search worth writing — so it must outlast a blip that the
  // calendar and page passes could afford to drop one listing over.
  let attempts = 0;

  const result = await withRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw new HttpError(500, 'https://www.airbnb.com/', 'server error');
    return 'ok';
  }, FAST);

  expect(attempts).toBe(3);
  expect(result).toBe('ok');
});

it('throws rather than returning short when it never recovers', async () => {
  // Giving up quietly would return a short page, which reads downstream as
  // "these are all the listings in this band" — the exact silent undercount
  // the search exists to prevent.
  const boom = new HttpError(503, 'https://www.airbnb.com/', 'nope');

  await expect(withRetries(async () => Promise.reject(boom), FAST)).rejects.toThrow(
    /failed after 4 attempts/,
  );
  await expect(
    withRetries(async () => Promise.reject(boom), FAST).catch((err: unknown) => {
      // The wrapper names the pass; the cause names what Airbnb actually said.
      expect(err).toBeInstanceOf(RetriesExhaustedError);
      throw (err as Error).cause;
    }),
  ).rejects.toBe(boom);
});

it('aborts immediately on a 429 rather than spending its retries on a ban', async () => {
  // The block is IP-wide and lasts on the order of an hour, so three
  // attempts half a second apart accomplish nothing but more knocking.
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
  // Mild overage stalls connections rather than refusing them, so a run of
  // timeouts is the only warning before the expensive failure.
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

it('does not mistake a room id or a response body for a rate limit', async () => {
  // A 429 aborts the whole run, so the check is on the status code and
  // never on the text: "429" turns up in listing ids and in quoted error
  // pages, and either would kill a healthy run outright.
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
