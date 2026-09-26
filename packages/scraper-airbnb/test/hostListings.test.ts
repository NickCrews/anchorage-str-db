import { describe, expect, it } from 'vitest';

import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { parseHostListingsPage } from '../src/api/hostListings.ts';
import {
  fetchHostListings,
  PAGE_SIZE,
  readHostListings,
  type FetchHostListingsPage,
} from '../src/hostListings.ts';

/** `count` listing ids, in the order a profile lists them. */
function listingIds(count: number, from = 1): string[] {
  return [...Array(count).keys()].map((i) => String(from + i));
}

/** One profile entry as Airbnb sends it (listing 48397619, 2026-09-26). */
function entry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'BeehiveListing',
    id,
    isNewListing: false,
    isSuperhost: false,
    nameOrPlaceholderName: 'Snowbird Chalet #5 | Walk to Lift | Fireplace',
    pictureUrl: `https://a0.muscache.com/im/pictures/prohost-api/Hosting-${id}/original/b0c77ae0.jpeg?aki_policy=large`,
    propertyTypeName: 'Chalet',
    ratingAverage: 4.55,
    reviewCount: '165',
    roomTypeCategory: 'entire_home',
    localizedRoomType: 'Entire home/apt',
    ...overrides,
  };
}

/** A response body as Airbnb sends it. */
function body(ids: readonly string[], entries = ids.map((id) => entry(id))): string {
  return JSON.stringify({
    data: {
      beehive: {
        __typename: 'BeehiveQuery',
        getListOfListings: { __typename: 'BeehiveGetListOfListingsResponse', listings: entries },
      },
    },
    extensions: { traceId: 'MqXAypMeWcev9GvV5Jx_Zg==' },
  });
}

const ids = (result: { listings: Array<{ listingId: string }> | null }) =>
  result.listings?.map((listing) => listing.listingId) ?? null;

interface FakeHost {
  listings?: string[];
  /** Served for every request instead of a listing page. */
  raw?: string;
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
    if (host?.raw !== undefined) return host.raw;
    // An unknown host id gets an empty list, as from Airbnb.
    return body((host?.listings ?? []).slice(offset, offset + limit));
  };
  return { fetchPage, calls };
}

describe('readHostListings', () => {
  it('reads a whole portfolio in one request, every field kept', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(65) } });

    const result = await readHostListings('100', fetchPage);

    expect(result.fetchOk).toBe(true);
    expect(result.error).toBeNull();
    expect(ids(result)).toEqual(listingIds(65));
    expect(result.listings![0]).toEqual({
      listingId: '1',
      name: 'Snowbird Chalet #5 | Walk to Lift | Fireplace',
      photoUrl: 'https://a0.muscache.com/im/pictures/prohost-api/Hosting-1/original/b0c77ae0.jpeg?aki_policy=large',
      buildingType: 'Chalet',
      listingType: 'Entire home/apt',
      listingTypeKey: 'entire_home',
      ratingValue: 4.55,
      reviewCount: 165,
      isSuperhost: false,
      isNewListing: false,
    });
    expect(result.responses).toEqual([body(listingIds(65))]);
    expect(calls).toEqual([{ hostId: '100', offset: 0, limit: PAGE_SIZE }]);
  });

  it('reads a host with nothing listed as no listings', async () => {
    const { fetchPage } = fakeEndpoint({ '100': { listings: [] } });

    const result = await readHostListings('100', fetchPage);
    expect(result.fetchOk).toBe(true);
    expect(result.listings).toEqual([]);
  });

  it('pages past a full page', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(PAGE_SIZE + 990) } });

    const result = await readHostListings('100', fetchPage);
    expect(result.listings).toHaveLength(PAGE_SIZE + 990);
    expect(result.responses).toHaveLength(2);
    expect(calls.map((call) => call.offset)).toEqual([0, PAGE_SIZE]);
  });

  it('needs one empty page after an exact multiple of the page size', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '100': { listings: listingIds(PAGE_SIZE) } });

    expect((await readHostListings('100', fetchPage)).listings).toHaveLength(PAGE_SIZE);
    expect(calls).toHaveLength(2);
  });

  it('counts a listing once when a shifted page repeats it', async () => {
    // A listing added between requests pushes the last listing of page one
    // onto page two.
    const fetchPage: FetchHostListingsPage = async (_hostId, offset) =>
      body(offset === 0 ? listingIds(PAGE_SIZE) : listingIds(5, PAGE_SIZE));

    expect((await readHostListings('100', fetchPage)).listings).toHaveLength(PAGE_SIZE + 4);
  });

  it('keeps a body it cannot parse, and says why', async () => {
    const changed = JSON.stringify({ data: { beehive: { listingsV2: { edges: [] } } } });
    const { fetchPage } = fakeEndpoint({ '100': { raw: changed } });

    expect(await readHostListings('100', fetchPage)).toEqual({
      hostId: '100',
      fetchOk: true,
      listings: null,
      responses: [changed],
      error: 'Error: profile listings response for host 100 has no listings list',
    });
  });

  it('keeps the body verbatim when it carries a field the columns have no place for', async () => {
    const raw = body(['1'], [entry('1', { cityName: 'Maui' })]);
    const { fetchPage } = fakeEndpoint({ '100': { raw } });

    expect(await readHostListings('100', fetchPage)).toEqual({
      hostId: '100',
      fetchOk: true,
      listings: null,
      responses: [raw],
      error: 'unrecognized in the response: unknown field cityName',
    });
  });

  it('records a failed request with its error', async () => {
    const { fetchPage } = fakeEndpoint({ '100': { error: new Error('HTTP 503 for https://www.airbnb.com/…') } });

    expect(await readHostListings('100', fetchPage)).toEqual({
      hostId: '100',
      fetchOk: false,
      listings: null,
      responses: [],
      error: 'Error: HTTP 503 for https://www.airbnb.com/…',
    });
  });

  it('gives up when the offset is ignored', async () => {
    const fetchPage: FetchHostListingsPage = async () => body(listingIds(PAGE_SIZE));

    const result = await readHostListings('100', fetchPage);
    expect(result.fetchOk).toBe(false);
    expect(result.error).toMatch(/still paging/);
  });
});

describe('fetchHostListings', () => {
  it('reads each host, one failure not stopping the rest', async () => {
    const { fetchPage } = fakeEndpoint({
      '100': { listings: listingIds(3) },
      '200': { error: new Error('HTTP 503') },
    });

    const results = await fetchHostListings(['100', '200'], { fetchPage });
    expect(results.map((result) => ({ hostId: result.hostId, fetchOk: result.fetchOk, ids: ids(result) }))).toEqual([
      { hostId: '100', fetchOk: true, ids: ['1', '2', '3'] },
      { hostId: '200', fetchOk: false, ids: null },
    ]);
  });

  it('aborts on a rate limit', async () => {
    const { fetchPage } = fakeEndpoint({ '100': { error: new RateLimitedError('HTTP 429') } });

    await expect(fetchHostListings(['100'], { fetchPage })).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('parseHostListingsPage', () => {
  it('reads a 19-digit listing id as a string', () => {
    expect(parseHostListingsPage(body(['1673497466101215704']), '100').listings[0]!.listingId).toBe(
      '1673497466101215704',
    );
  });

  it('reads nulls as nulls', () => {
    const page = parseHostListingsPage(
      body(['1'], [entry('1', { ratingAverage: null, reviewCount: null, pictureUrl: null })]),
      '100',
    );
    expect(page.unrecognized).toEqual([]);
    expect(page.listings[0]).toMatchObject({ ratingValue: null, reviewCount: null, photoUrl: null });
  });

  it('reports a value of an unexpected type, and a new field beside the list', () => {
    const raw = JSON.stringify({
      data: {
        beehive: {
          __typename: 'BeehiveQuery',
          getListOfListings: { listings: [entry('1', { reviewCount: 'many' })], totalCount: 1 },
        },
      },
    });
    expect(parseHostListingsPage(raw, '100').unrecognized).toEqual([
      'reviewCount: "many"',
      'unknown field getListOfListings.totalCount',
    ]);
  });

  it('throws on GraphQL errors', () => {
    const errors = JSON.stringify({ errors: [{ message: 'Sorry, something went wrong.' }] });

    expect(() => parseHostListingsPage(errors, '100')).toThrow(/Sorry, something went wrong/);
  });

  it('throws on a body that is not JSON', () => {
    expect(() => parseHostListingsPage('<html>Access denied</html>', '100')).toThrow(/not JSON: <html>/);
  });

  it('throws on an entry without an id', () => {
    const data = JSON.stringify({ data: { beehive: { getListOfListings: { listings: [entry('1'), {}] } } } });

    expect(() => parseHostListingsPage(data, '100')).toThrow(/no listing id/);
  });
});
