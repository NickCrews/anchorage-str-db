import { describe, expect, it } from 'vitest';

import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { toHostListingIds } from '../src/api/hostListings.ts';
import {
  fetchHostListings,
  listHostListings,
  PAGE_SIZE,
  type FetchHostListingsPage,
} from '../src/hostListings.ts';

/** `count` listing ids, in the order a profile lists them. */
function listingIds(count: number, from = 1): string[] {
  return [...Array(count).keys()].map((i) => String(from + i));
}

interface FakeHost {
  listings?: string[];
  error?: Error;
}

/** A profile-listings endpoint over fixed hosts, recording each request. */
function fakeEndpoint(hosts: Record<string, FakeHost>): {
  fetchPage: FetchHostListingsPage;
  calls: Array<{ hostId: string; offset: number; limit: number }>;
} {
  const calls: Array<{ hostId: string; offset: number; limit: number }> = [];
  const fetchPage: FetchHostListingsPage = async (hostId, offset, limit) => {
    calls.push({ hostId, offset, limit });
    const host = hosts[hostId];
    if (host?.error) throw host.error;
    // An unknown host id gets an empty list, as from Airbnb.
    return (host?.listings ?? []).slice(offset, offset + limit);
  };
  return { fetchPage, calls };
}

describe('listHostListings', () => {
  it('reads a portfolio smaller than a page in one request', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(65) } });

    expect(await listHostListings('100', fetchPage)).toEqual(listingIds(65));
    expect(calls).toEqual([{ hostId: '100', offset: 0, limit: PAGE_SIZE }]);
  });

  it('pages until a short page', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(207) } });

    expect(await listHostListings('100', fetchPage)).toHaveLength(207);
    expect(calls.map((call) => call.offset)).toEqual([0, PAGE_SIZE, 2 * PAGE_SIZE]);
  });

  it('needs one empty page after an exact multiple of the page size', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(PAGE_SIZE) } });

    expect(await listHostListings('100', fetchPage)).toHaveLength(PAGE_SIZE);
    expect(calls).toHaveLength(2);
  });

  it('reads a host with nothing listed as zero listings', async () => {
    const { fetchPage } = fakeEndpoint({ '100': { listings: [] } });

    expect(await listHostListings('100', fetchPage)).toEqual([]);
  });

  it('counts a listing once when a shifted page repeats it', async () => {
    // A listing added between requests pushes listing 100 onto the second page.
    const fetchPage: FetchHostListingsPage = async (_hostId, offset) =>
      offset === 0 ? listingIds(PAGE_SIZE) : listingIds(5, PAGE_SIZE);

    expect(await listHostListings('100', fetchPage)).toHaveLength(PAGE_SIZE + 4);
  });

  it('throws when the offset is ignored', async () => {
    const fetchPage: FetchHostListingsPage = async () => listingIds(PAGE_SIZE);

    await expect(listHostListings('100', fetchPage)).rejects.toThrow(/still paging/);
  });
});

describe('fetchHostListings', () => {
  it('records a per-host failure and keeps going', async () => {
    const { fetchPage } = fakeEndpoint({
      '100': { listings: listingIds(3) },
      '200': { error: new Error('HttpError: HTTP 503') },
    });

    expect(await fetchHostListings(['100', '200'], { fetchPage })).toEqual([
      { hostId: '100', listingIds: ['1', '2', '3'], error: null },
      { hostId: '200', listingIds: null, error: 'Error: HttpError: HTTP 503' },
    ]);
  });

  it('aborts on a rate limit', async () => {
    const { fetchPage } = fakeEndpoint({ '100': { error: new RateLimitedError('HTTP 429') } });

    await expect(fetchHostListings(['100'], { fetchPage })).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('toHostListingIds', () => {
  const response = (listings: unknown[]) => ({
    data: { beehive: { getListOfListings: { listings } } },
  });

  it('reads each listing id', () => {
    const data = response([
      { __typename: 'BeehiveListing', id: '48397619', nameOrPlaceholderName: 'Snowbird Chalet #5' },
      { __typename: 'BeehiveListing', id: '1673497466101215704' },
    ]);

    expect(toHostListingIds(data as never, '100')).toEqual(['48397619', '1673497466101215704']);
  });

  it('throws on GraphQL errors', () => {
    const data = { errors: [{ message: 'Sorry, something went wrong.' }] };

    expect(() => toHostListingIds(data, '100')).toThrow(/Sorry, something went wrong/);
  });

  it('throws when the listings list is missing', () => {
    expect(() => toHostListingIds({ data: { beehive: {} } }, '100')).toThrow(/no listings list/);
  });

  it('throws on an entry without an id', () => {
    expect(() => toHostListingIds(response([{ id: '1' }, {}]) as never, '100')).toThrow(/no listing id/);
  });
});
