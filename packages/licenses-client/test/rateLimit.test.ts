/**
 * The license page fetcher's handling of the portal's HTTP 429, offline:
 * `fetch` is stubbed, so these make no requests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Pacer } from '@anchorage-str-db/utils/pace';

import { fetchLicensePages, liveLicensePageFetcher } from '../src/licensePage.ts';

const HIDDEN_PAGE = '<html><head><title>Invalid License</title></head><body><h1>License Not Found</h1></body></html>';

/** Stub `fetch` to answer each request with the next of `responses`, repeating the last. */
function stubPortal(responses: readonly (() => Response)[]): { requests: () => number } {
  let requests = 0;
  vi.stubGlobal('fetch', async () => responses[Math.min(requests++, responses.length - 1)]!());
  return { requests: () => requests };
}

function tooManyRequests(headers: Record<string, string> = {}): Response {
  return new Response('<html><title>Too Many Requests</title></html>', { status: 429, headers });
}

/** The portal's policy, scaled down so a test never waits long. */
function fastPacer(maxWaitMs = 10): Pacer {
  return new Pacer({ rate: 1e6, minRate: 1, rateLimit: { action: 'slowDown', waitMs: 1, maxWaitMs } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a 429 from the portal', () => {
  it('slows the pacer and retries, rather than failing the read', async () => {
    const portal = stubPortal([tooManyRequests, tooManyRequests, () => new Response(HIDDEN_PAGE)]);
    const pacer = fastPacer();

    const page = await liveLicensePageFetcher(pacer)(50);

    expect(page).toEqual({ hidden: true, cityviewLicenseId: 50 });
    expect(portal.requests()).toBe(3);
    expect(pacer.rateLimited).toBe(2);
    expect(pacer.bucket.rate).toBe(0.25e6);
  });

  it('honours Retry-After, up to the longest wait', async () => {
    stubPortal([() => tooManyRequests({ 'Retry-After': '120' }), () => new Response(HIDDEN_PAGE)]);
    const started = performance.now();

    await liveLicensePageFetcher(fastPacer(60))(50);

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('fails the read only once every attempt was refused, and records it as a result', async () => {
    const portal = stubPortal([tooManyRequests]);

    const results = await fetchLicensePages([50], {
      fetchOne: liveLicensePageFetcher(fastPacer()),
    });

    expect(portal.requests()).toBe(3);
    expect(results).toEqual([{ cityviewLicenseId: 50, page: null, error: expect.stringMatching(/HTTP 429/) }]);
  });
});
