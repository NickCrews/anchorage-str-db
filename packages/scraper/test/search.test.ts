/**
 * Band arithmetic, the convergence loop, and the coverage audit.
 *
 * The bands must tile [0, inf) with no gap, because a gap is exactly the
 * failure this module exists to prevent — silently invisible listings, in a
 * result that looks complete.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { BoundingBox } from '../src/airbnb/search.ts';
import * as config from '../src/config.ts';
import { resetPace } from '../src/pace.ts';
import {
  auditCoverage,
  missRate,
  PriceBand,
  searchAnchorage,
  type FetchPage,
  type SearchPage,
} from '../src/search.ts';
import { makeSearchListing } from './fixtures.ts';

// Tests never really sleep: a pacer this fast hands out a token immediately.
beforeEach(() => {
  resetPace({ rate: 1e6 });
});

function covers(bands: readonly PriceBand[], price: number): boolean {
  return bands.some(
    (band) => band.minUsd <= price && (band.maxUsd === null || price <= band.maxUsd),
  );
}

describe('price bands', () => {
  it('leave no gap at any whole dollar', () => {
    const bands = config.PRICE_BAND_SEEDS_USD.map(([lo, hi]) => new PriceBand(lo, hi));
    const uncovered = [...Array(5000).keys()].filter((price) => !covers(bands, price));
    expect(uncovered).toEqual([]);
  });

  it('cover everything the parent did when split', () => {
    // `price_max=X` and `price_min=X` are complementary, so abutting halves
    // lose nothing at the boundary. Measured on single-page queries:
    // splitting a 26-listing box at $100/$125/$150/$200 gave below+above ==
    // 26 every time, with no duplicate and no gap.
    const parent = new PriceBand(100, 200);
    const halves = parent.split()!;
    for (let price = parent.minUsd; price <= parent.maxUsd!; price++) {
      expect(covers(halves, price), `$${price} fell between the halves`).toBe(true);
    }
  });

  it('never open a gap under repeated splitting', () => {
    let frontier = [new PriceBand(0, 1000)];
    for (let i = 0; i < 6; i++) {
      frontier = frontier.flatMap((band) => band.split() ?? [band]);
    }
    const uncovered = [...Array(1001).keys()].filter((price) => !covers(frontier, price));
    expect(uncovered).toEqual([]);
  });

  it('keep the open top band open-ended when split', () => {
    const halves = new PriceBand(1000, null).split()!;
    expect(halves.at(-1)!.maxUsd).toBeNull();
    for (const price of [1000, 1500, 2000, 10_000]) {
      expect(covers(halves, price)).toBe(true);
    }
  });

  it('report null when too narrow to split', () => {
    expect(new PriceBand(100, 100 + config.PRICE_BAND_MIN_WIDTH_USD - 1).split()).toBeNull();
  });
});

// --------------------------------------------------------------------------
// the convergence loop

type BandKey = string;

function bandKey(band: PriceBand | null): BandKey {
  return band === null ? 'unfiltered' : `${band.minUsd}:${band.maxUsd}`;
}

/** A stub `FetchPage` keyed by band, defaulting to an empty single page. */
function stubPages(byBand: Record<BandKey, SearchPage>): FetchPage {
  return async (band) => byBand[bandKey(band)] ?? { listings: [], pageCount: 1 };
}

function page(roomIds: readonly number[], pageCount = 1): SearchPage {
  return { listings: roomIds.map((id) => makeSearchListing(id)), pageCount };
}

describe('searchAnchorage', () => {
  it('accepts a single-page band as complete', async () => {
    const seeds = config.PRICE_BAND_SEEDS_USD;
    const first = seeds[0]!;
    const result = await searchAnchorage({
      fetchPage: stubPages({ [`${first[0]}:${first[1]}`]: page([...Array(10).keys()]) }),
    });

    expect(result.queries).toBe(seeds.length);
    expect(result.listings).toHaveLength(10);
    expect(result.unresolved).toEqual([]);
  });

  it('splits a multi-page band rather than paginating it', async () => {
    // Covers both of Airbnb's pagination defects. Walking the pages of this
    // band would return at most 280 of its listings, in a set that
    // changes between identical calls; halving it until each half fits one
    // page returns all of them, reproducibly.
    const capped = config.PRICE_BAND_SEEDS_USD[0]!;
    const halves = new PriceBand(capped[0], capped[1]).split()!;
    const result = await searchAnchorage({
      fetchPage: stubPages({
        [`${capped[0]}:${capped[1]}`]: page([...Array(40).keys()], 7),
        [bandKey(halves[0])]: page([1000, 1001, 1002, 1003, 1004]),
        [bandKey(halves[1])]: page([2000, 2001, 2002, 2003, 2004, 2005, 2006]),
      }),
    });

    // The parent's own page-1 sample is discarded in favour of the halves.
    expect(
      result.listings.map((listing) => listing.roomId).sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual([
      1000n, 1001n, 1002n, 1003n, 1004n, 2000n, 2001n, 2002n, 2003n, 2004n, 2005n, 2006n,
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('reports a band that cannot be narrowed to one page', async () => {
    // More than a page of listings at a single price is something price can
    // no longer separate. The query answering it is truncatable and
    // unstable, and nothing in the data would show that, so it fails the run.
    const result = await searchAnchorage({
      seeds: [[100, 101]],
      fetchPage: stubPages({ '100:101': page([...Array(40).keys()], 3) }),
    });

    expect(result.unresolved).toHaveLength(1);
    expect(String(result.unresolved[0])).toBe('$100-101');
  });

  it('issues exactly one request per band and never follows a cursor', async () => {
    // The whole design rests on not paginating: a multi-page result set is
    // both silently truncatable at 280 items and re-ranked between fetches.
    let calls = 0;
    const result = await searchAnchorage({
      seeds: [[0, 100]],
      fetchPage: async () => {
        calls += 1;
        return page([1], 1);
      },
    });

    expect(calls).toBe(1);
    expect(result.listings.map((listing) => listing.roomId)).toEqual([1n]);
  });
});

// --------------------------------------------------------------------------
// coverage audit — the check that we are finding all of the municipality,
// rather than merely finding a self-consistent subset of it.

const KNOWN = [...Array(20).keys()].map((id) => makeSearchListing(id));

describe('auditCoverage', () => {
  it('reports zero misses when the bands found everything', async () => {
    const audit = await auditCoverage(KNOWN, '2026-08-18', {
      fetchPage: async () => page([1, 2]),
    });

    expect(audit.boxes).toBe(config.COVERAGE_AUDIT_SAMPLE);
    expect(audit.missedIds).toHaveLength(0);
    expect(missRate(audit)).toBe(0);
  });

  it('catches a listing the price bands never returned', async () => {
    // The failure banding can have and geography cannot: a listing with no
    // price Airbnb will filter on falls in no band, so it is absent from a
    // result that looks completely healthy. Only a query with no price
    // filter can see it.
    const audit = await auditCoverage(KNOWN, '2026-08-18', {
      fetchPage: async () => page([1, 999_001]),
    });

    expect(audit.missedIds.filter((id) => id === 999_001n)).toHaveLength(audit.boxes);
    expect(missRate(audit)).toBe(0.5);
  });

  it('skips a box that needs more than one page', async () => {
    // A multi-page audit box is unstable itself, so it cannot testify about
    // what the search missed. Counting it would manufacture misses.
    const audit = await auditCoverage(KNOWN, '2026-08-18', {
      fetchPage: async () => page([9], 4),
    });

    expect(audit.boxes).toBe(0);
    expect(audit.missedIds).toHaveLength(0);
  });

  it('is reproducible for a date but moves between days', async () => {
    const spread = [...Array(200).keys()].map((i) =>
      makeSearchListing(i, { latitude: 61 + i / 1000 }),
    );
    const boxesFor = async (scrapeDate: string): Promise<number[]> => {
      const seen: number[] = [];
      const record: FetchPage = async (_band, box: BoundingBox) => {
        seen.push(Number(box.swLat.toFixed(6)));
        return { listings: [], pageCount: 1 };
      };
      await auditCoverage(spread, scrapeDate, { fetchPage: record });
      return seen;
    };

    const first = await boxesFor('2026-08-18');
    const sameDay = await boxesFor('2026-08-18');
    const nextDay = await boxesFor('2026-08-19');

    expect(sameDay).toEqual(first);
    expect(nextDay).not.toEqual(first);
  });

  it('does not run at all when no listing carries a coordinate', async () => {
    const unlocated = [makeSearchListing(1, { latitude: null, longitude: null })];
    const audit = await auditCoverage(unlocated, '2026-08-18', {
      fetchPage: async () => {
        throw new Error('must not search without a box to centre');
      },
    });

    expect(audit.boxes).toBe(0);
  });
});
