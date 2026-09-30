/**
 * Price bands, band splitting, and the coverage audit. Bands must cover
 * [0, inf) with no gap, or listings in the gap are never found.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { BoundingBox } from '../src/api/search.ts';
import { resetPace } from '../src/pace.ts';
import {
  auditCoverage,
  COVERAGE_AUDIT_SAMPLE,
  missRate,
  PRICE_BAND_MIN_WIDTH_USD,
  PRICE_BAND_SEEDS_USD,
  PriceBand,
  searchAnchorage,
  splitBox,
  type FetchPage,
  type SearchPage,
} from '../src/search.ts';
import { makeSearchListing } from './fixtures.ts';

// A pacer this fast never sleeps.
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
    const bands = PRICE_BAND_SEEDS_USD.map(([lo, hi]) => new PriceBand(lo, hi));
    const uncovered = [...Array(5000).keys()].filter((price) => !covers(bands, price));
    expect(uncovered).toEqual([]);
  });

  it('cover everything the parent did when split', () => {
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
    expect(new PriceBand(100, 100 + PRICE_BAND_MIN_WIDTH_USD - 1).split()).toBeNull();
  });
});

// --------------------------------------------------------------------------
// band splitting

type BandKey = string;

function bandKey(band: PriceBand | null): BandKey {
  return band === null ? 'unfiltered' : `${band.minUsd}:${band.maxUsd}`;
}

/** A stub `FetchPage` keyed by band, defaulting to an empty single page. */
function stubPages(byBand: Record<BandKey, SearchPage>): FetchPage {
  return async (band) => byBand[bandKey(band)] ?? { listings: [], pageCount: 1 };
}

function page(listingIds: readonly number[], pageCount = 1): SearchPage {
  return { listings: listingIds.map((id) => makeSearchListing(id)), pageCount };
}

describe('searchAnchorage', () => {
  it('accepts a single-page band as complete', async () => {
    const seeds = PRICE_BAND_SEEDS_USD;
    const first = seeds[0]!;
    const result = await searchAnchorage({
      fetchPage: stubPages({ [`${first[0]}:${first[1]}`]: page([...Array(10).keys()]) }),
    });

    expect(result.queries).toBe(seeds.length);
    expect(result.listings).toHaveLength(10);
    expect(result.unresolved).toEqual([]);
  });

  it('splits a multi-page band rather than paginating it', async () => {
    const capped = PRICE_BAND_SEEDS_USD[0]!;
    const halves = new PriceBand(capped[0], capped[1]).split()!;
    const result = await searchAnchorage({
      fetchPage: stubPages({
        [`${capped[0]}:${capped[1]}`]: page([...Array(40).keys()], 7),
        [bandKey(halves[0])]: page([1000, 1001, 1002, 1003, 1004]),
        [bandKey(halves[1])]: page([2000, 2001, 2002, 2003, 2004, 2005, 2006]),
      }),
    });

    // Only the halves' listings, not the parent's.
    expect(
      result.listings.map((listing) => listing.listingId).sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual([
      1000n, 1001n, 1002n, 1003n, 1004n, 2000n, 2001n, 2002n, 2003n, 2004n, 2005n, 2006n,
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('splits by location when a band is too narrow to split by price', async () => {
    const box: BoundingBox = { swLat: 61, swLng: -150, neLat: 61.1, neLng: -149.8 };
    const [first] = splitBox(box)!;
    const result = await searchAnchorage({
      box,
      seeds: [[125, 126]],
      fetchPage: async (_band, where) => {
        if (where === box) return page([...Array(40).keys()], 2);
        if (JSON.stringify(where) === JSON.stringify(first)) return page([1, 2, 3]);
        return page([3, 4]);
      },
    });

    expect(result.unresolved).toEqual([]);
    expect(result.queries).toBe(3);
    expect(result.listings.map((listing) => listing.listingId)).toEqual([1n, 2n, 3n, 3n, 4n]);
  });

  it('reports a band that cannot be narrowed to one page', async () => {
    // Under 1 km on a side, so it splits once more and then gives up.
    const box: BoundingBox = { swLat: 61, swLng: -150, neLat: 61.006, neLng: -149.992 };
    const result = await searchAnchorage({
      box,
      seeds: [[100, 101]],
      fetchPage: async () => page([...Array(40).keys()], 3),
    });

    expect(result.queries).toBe(3);
    expect(result.unresolved.map(String)).toEqual(['$100-101', '$100-101']);
  });

  it('issues exactly one request per band and never follows a cursor', async () => {
    let calls = 0;
    const result = await searchAnchorage({
      seeds: [[0, 100]],
      fetchPage: async () => {
        calls += 1;
        return page([1], 1);
      },
    });

    expect(calls).toBe(1);
    expect(result.listings.map((listing) => listing.listingId)).toEqual([1n]);
  });
});

describe('splitBox', () => {
  it('halves across the longer side and covers the parent', () => {
    // 0.1 deg lat is ~11 km; 0.4 deg lng at 61N is ~21.6 km.
    const box: BoundingBox = { swLat: 61, swLng: -150, neLat: 61.1, neLng: -149.6 };
    const [a, b] = splitBox(box)!;
    expect(a).toEqual({ ...box, neLng: -149.8 });
    expect(b).toEqual({ ...box, swLng: -149.8 });

    const tall: BoundingBox = { swLat: 61, swLng: -150, neLat: 61.2, neLng: -149.9 };
    const [south, north] = splitBox(tall)!;
    expect(south.neLat).toBeCloseTo(61.1);
    expect(north.swLat).toBeCloseTo(61.1);
    expect(south.swLng).toBe(tall.swLng);
  });

  it('returns null for a box too small to split', () => {
    expect(splitBox({ swLat: 61, swLng: -150, neLat: 61.001, neLng: -149.998 })).toBeNull();
  });
});

// --------------------------------------------------------------------------
// coverage audit

const KNOWN = [...Array(20).keys()].map((id) => makeSearchListing(id));

describe('auditCoverage', () => {
  it('reports zero misses when the bands found everything', async () => {
    const audit = await auditCoverage(KNOWN, '2026-08-18', {
      fetchPage: async () => page([1, 2]),
    });

    expect(audit.boxes).toBe(COVERAGE_AUDIT_SAMPLE);
    expect(audit.missedIds).toHaveLength(0);
    expect(missRate(audit)).toBe(0);
  });

  it('catches a listing the price bands never returned', async () => {
    const audit = await auditCoverage(KNOWN, '2026-08-18', {
      fetchPage: async () => page([1, 999_001]),
    });

    expect(audit.missedIds.filter((id) => id === 999_001n)).toHaveLength(audit.boxes);
    expect(missRate(audit)).toBe(0.5);
  });

  it('skips a box that needs more than one page', async () => {
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
        throw new Error('must not search without a box to center');
      },
    });

    expect(audit.boxes).toBe(0);
  });
});
