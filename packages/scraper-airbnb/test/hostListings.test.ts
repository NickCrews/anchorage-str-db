import { describe, expect, it } from 'vitest';

import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { toHostListingIds } from '../src/api/hostListings.ts';
import {
  countHostListings,
  fetchHostListings,
  PAGE_SIZE,
  type FetchHostListingPage,
} from '../src/hostListings.ts';

/** `count` listing ids, as Airbnb returns them. */
function listingIds(count: number, from = 1000): string[] {
  return [...Array(count).keys()].map((i) => String(from + i));
}

interface FakeHost {
  listings?: string[];
  error?: Error;
}

/** A profile-listings endpoint over fixed hosts, recording each request. */
function fakeEndpoint(hosts: Record<string, FakeHost>): {
  fetchPage: FetchHostListingPage;
  calls: Array<{ hostId: string; offset: number; limit: number }>;
} {
  const calls: Array<{ hostId: string; offset: number; limit: number }> = [];
  const fetchPage: FetchHostListingPage = async (hostId, offset, limit) => {
    calls.push({ hostId, offset, limit });
    const host = hosts[hostId];
    // Airbnb answers an unknown account with an empty list, not an error.
    if (!host) return [];
    if (host.error) throw host.error;
    return (host.listings ?? []).slice(offset, offset + limit);
  };
  return { fetchPage, calls };
}

describe('countHostListings', () => {
  it('counts a host with one listing in one request', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(1) } });

    expect(await countHostListings('100', fetchPage)).toEqual({ listingsAnywhere: 1, requests: 1 });
    expect(calls).toEqual([{ hostId: '100', offset: 0, limit: PAGE_SIZE }]);
  });

  it('pages through a host with more listings than a page holds', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(206) } });

    expect(await countHostListings('100', fetchPage)).toEqual({ listingsAnywhere: 206, requests: 3 });
    expect(calls.map((call) => call.offset)).toEqual([0, PAGE_SIZE, 2 * PAGE_SIZE]);
  });

  it('asks once more when the list ends exactly on a page boundary', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(PAGE_SIZE) } });

    expect(await countHostListings('100', fetchPage)).toEqual({
      listingsAnywhere: PAGE_SIZE,
      requests: 2,
    });
    expect(calls).toHaveLength(2);
  });

  it('counts zero for an account with no listings', async () => {
    const { fetchPage } = fakeEndpoint({});

    expect(await countHostListings('1', fetchPage)).toEqual({ listingsAnywhere: 0, requests: 1 });
  });

  it('refuses pages that repeat a listing rather than overcount', async () => {
    // An endpoint that ignores the offset returns the first page forever.
    const first = listingIds(PAGE_SIZE);
    const fetchPage: FetchHostListingPage = async () => first;

    await expect(countHostListings('100', fetchPage)).rejects.toThrow(/repeats at offset 100/);
  });
});

describe('fetchHostListings', () => {
  it('records a per-host failure and carries on', async () => {
    const { fetchPage } = fakeEndpoint({
      '100': { listings: listingIds(3) },
      '200': { error: new Error('HTTP 503') },
    });

    expect(await fetchHostListings(['100', '200'], { fetchPage })).toEqual([
      { hostId: '100', listingsAnywhere: 3, requests: 1, error: null },
      { hostId: '200', listingsAnywhere: null, requests: 0, error: 'Error: HTTP 503' },
    ]);
  });

  it('aborts on a rate limit', async () => {
    const { fetchPage } = fakeEndpoint({
      '100': { error: new RateLimitedError('slow down') },
    });

    await expect(fetchHostListings(['100'], { fetchPage })).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('toHostListingIds', () => {
  const response = (listings: unknown) => ({
    data: { beehive: { getListOfListings: { listings } } },
  });

  it('reads the ids in response order', () => {
    expect(
      toHostListingIds(response([{ id: '33153126' }, { id: '715065' }]) as never, '3682901'),
    ).toEqual(['33153126', '715065']);
  });

  it('throws on GraphQL errors, a missing list, or an entry with no id', () => {
    expect(() => toHostListingIds({ errors: [{ message: 'PersistedQueryNotFound' }] }, '1')).toThrow(
      /PersistedQueryNotFound/,
    );
    expect(() => toHostListingIds({ data: {} }, '1')).toThrow(/no listing list/);
    expect(() => toHostListingIds(response([{ name: 'Cabin' }]) as never, '1')).toThrow(/no id/);
  });
});
