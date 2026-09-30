/**
 * Search Anchorage in price bands narrow enough that each fits on one page,
 * then audit coverage with a differently shaped query.
 *
 * Airbnb's paginated search silently stops at 280 items and re-ranks between
 * page fetches, so listings are duplicated or skipped. A single-page query
 * has neither problem. This module never paginates: when a response reports
 * more than one page (`pageCursors`), it halves the price band and retries,
 * and once the band is too narrow to halve, it halves the bounding box.
 */

import { epochDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { log } from '@anchorage-str-db/utils/log';
import { MUNICIPALITY_BOUNDING_BOX } from '@anchorage-str-db/utils/muni_geography';

import {
  fetchSearchPage,
  standardizeSearchResponse,
  type BoundingBox,
  type SearchListing,
} from './api/search.ts';
import { withRetries } from './retry.ts';

/**
 * Sent to Airbnb's map search but has no effect on results: zoom 11 through
 * 15 return identical sets for the same box.
 */
const ZOOM_VALUE = 11;

/**
 * Listings per search page.
 *
 * A paginated search is unreliable: it silently stops at 280 items, and it
 * re-ranks between page fetches, duplicating some listings and skipping
 * others (0 listings churned at 1 page, 69 at 7 pages). A single-page query
 * returns the same set every time, so `searchAnchorage` splits by price until
 * each query fits on one page.
 *
 * Measurements and rejected alternatives are in
 * docs/research/airbnb-search-pagination.md.
 */
const SEARCH_PAGE_SIZE = 40;

/**
 * Bands this narrow are not split further by price. One that still needs more
 * than a page (over 40 listings at one price, as $125-126 had on 2026-09-29)
 * is split by location instead (see `splitBox`).
 */
export const PRICE_BAND_MIN_WIDTH_USD = 1;

/**
 * Boxes whose longer side is this short are not split further. A band that
 * still needs more than a page in one fails the `search_single_page` check.
 * Airbnb fuzzes unexact locations by a few hundred metres, so a smaller box
 * would not separate listings reliably anyway.
 */
export const BOX_MIN_SIDE_KM = 0.5;

const KM_PER_DEGREE_LAT = 111.32;

/** Width and height of `box` in km. */
function boxSidesKm(box: BoundingBox): { widthKm: number; heightKm: number } {
  const midLat = (box.swLat + box.neLat) / 2;
  return {
    widthKm: (box.neLng - box.swLng) * KM_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180),
    heightKm: (box.neLat - box.swLat) * KM_PER_DEGREE_LAT,
  };
}

/**
 * Two halves of `box` split across its longer side, or null if that side is
 * under `BOX_MIN_SIDE_KM`. The halves share the midline, so a listing on it
 * may come back from both; callers dedupe by listing id.
 */
export function splitBox(box: BoundingBox): [BoundingBox, BoundingBox] | null {
  const { widthKm, heightKm } = boxSidesKm(box);
  if (Math.max(widthKm, heightKm) < BOX_MIN_SIDE_KM) return null;
  if (widthKm >= heightKm) {
    const midLng = (box.swLng + box.neLng) / 2;
    return [
      { ...box, neLng: midLng },
      { ...box, swLng: midLng },
    ];
  }
  const midLat = (box.swLat + box.neLat) / 2;
  return [
    { ...box, neLat: midLat },
    { ...box, swLat: midLat },
  ];
}

function formatBox(box: BoundingBox): string {
  const f = (n: number): string => n.toFixed(4);
  return `[${f(box.swLat)},${f(box.swLng)} to ${f(box.neLat)},${f(box.neLng)}]`;
}

/**
 * A `price_min`/`price_max` window, in whole USD. `maxUsd === null` is the
 * open-ended top band.
 */
export class PriceBand {
  readonly minUsd: number;
  readonly maxUsd: number | null;

  constructor(minUsd: number, maxUsd: number | null) {
    this.minUsd = minUsd;
    this.maxUsd = maxUsd;
  }

  get width(): number {
    return this.maxUsd === null ? Infinity : this.maxUsd - this.minUsd;
  }

  /**
   * Two halves sharing a boundary, or null if the band is at minimum width.
   * Airbnb's `price_max=X` and `price_min=X` are complementary, so a listing
   * priced exactly X lands in only one half (see `PRICE_BAND_SEEDS_USD`).
   */
  split(): [PriceBand, PriceBand] | null {
    if (this.maxUsd === null) {
      // An open band can't be bisected, so split at double its floor.
      return [
        new PriceBand(this.minUsd, this.minUsd * 2),
        new PriceBand(this.minUsd * 2, null),
      ];
    }
    if (this.width <= PRICE_BAND_MIN_WIDTH_USD) return null;
    const mid = Math.floor((this.minUsd + this.maxUsd) / 2);
    return [new PriceBand(this.minUsd, mid), new PriceBand(mid, this.maxUsd)];
  }

  toString(): string {
    return `$${this.minUsd}-${this.maxUsd ?? 'inf'}`;
  }
}

/**
 * Attempts per search page. Higher than the per-listing passes because a
 * failed search page fails the run, while Airbnb's occasional 500 usually
 * succeeds on retry. Their backoff is longer, too, being more numerous.
 */
const SEARCH_MAX_RETRIES = 4;
const SEARCH_RETRY_BACKOFF_MS = 1500;

/** The first page of a search, and how many pages Airbnb says it has. */
export interface SearchPage {
  listings: SearchListing[];
  pageCount: number;
}

/** Fetch the first page of a search. Callers narrow the query instead of paginating. */
export type FetchPage = (band: PriceBand | null, box: BoundingBox) => Promise<SearchPage>;

/**
 * The live `FetchPage`. A failed search page fails the run, so it retries up
 * to `SEARCH_MAX_RETRIES` times; a 429 aborts immediately (see `retry.ts`).
 */
export function liveSearchFetcher(apiKey: string): FetchPage {
  return (band, box) =>
    withRetries(
      async () => {
        const raw = await fetchSearchPage({
          apiKey,
          box,
          zoom: ZOOM_VALUE,
          currency: 'USD',
          language: 'en',
          priceMinUsd: band?.minUsd,
          priceMaxUsd: band?.maxUsd ?? undefined,
        });
        const { listings, pageCount } = standardizeSearchResponse(raw);
        return { listings, pageCount };
      },
      {
        label: 'search page',
        attempts: SEARCH_MAX_RETRIES,
        backoffMs: SEARCH_RETRY_BACKOFF_MS,
        onRetry: (err, attempt) => {
          log.warn(`search page failed (attempt ${attempt}), retrying: ${String(err)}`);
        },
      },
    );
}

/**
 * One run's search pass. `unresolved` lists bands that still needed more than
 * one page at minimum price width in a minimum-size box, so their results may
 * be incomplete.
 */
export interface SearchResult {
  listings: SearchListing[];
  queries: number;
  unresolved: PriceBand[];
}

/**
 * Initial price bands. Adjacent bands share a boundary without overlap:
 * `price_max=X` and `price_min=X` are complementary (splitting a 26-listing
 * box at $100/$125/$150/$200 gave below+above == 26 each time). Test
 * boundaries only on single-page queries, where pagination churn can't look
 * like a gap.
 *
 * `null` is the open-ended top band.
 */
export const PRICE_BAND_SEEDS_USD: ReadonlyArray<readonly [number, number | null]> = [
  [0, 50],
  [50, 75],
  [75, 100],
  [100, 125],
  [125, 150],
  [150, 175],
  [175, 200],
  [200, 250],
  [250, 300],
  [300, 500],
  [500, 1000],
  [1000, null],
];

export interface SearchOptions {
  fetchPage: FetchPage;
  box?: BoundingBox;
  seeds?: ReadonlyArray<readonly [number, number | null]>;
}

/**
 * Search the whole box, splitting by price until no query needs a second
 * page, and by location when a $1 band still needs one. Queries cover `box`,
 * by default the bounding box of the Municipality's boundary, which is
 * already padded by 1 km. Listings outside
 * the box are never searched. The box also takes in Hope, Palmer and
 * Wasilla, so the daily run keeps only the listings inside the boundary
 * itself.
 */
export async function searchAnchorage(options: SearchOptions): Promise<SearchResult> {
  const box = options.box ?? MUNICIPALITY_BOUNDING_BOX;
  const seeds = options.seeds ?? PRICE_BAND_SEEDS_USD;
  const result: SearchResult = { listings: [], queries: 0, unresolved: [] };

  const visit = async (band: PriceBand, where: BoundingBox): Promise<void> => {
    const { listings, pageCount } = await options.fetchPage(band, where);
    result.queries += 1;
    const inBox = where === box ? '' : ` in ${formatBox(where)}`;
    const priceHalves = pageCount > 1 ? band.split() : null;
    // Only once price can't separate the listings, split the box instead.
    const boxHalves = pageCount > 1 && !priceHalves ? splitBox(where) : null;
    log.info(
      `search: ${band}${inBox} -> ${listings.length} results across ${pageCount} page(s)` +
        (priceHalves ? ' (splitting)' : boxHalves ? ' (splitting by location)' : ''),
    );
    // The parent's partial page is discarded; the halves replace it.
    if (priceHalves) {
      for (const half of priceHalves) await visit(half, where);
      return;
    }
    if (boxHalves) {
      for (const half of boxHalves) await visit(band, half);
      return;
    }
    if (pageCount > 1) {
      log.warn(
        `search: ${band}${inBox} still needs ${pageCount} pages and is too narrow to ` +
          `split — more than ${SEARCH_PAGE_SIZE} listings at one price in a ` +
          `${BOX_MIN_SIDE_KM} km box`,
      );
      result.unresolved.push(band);
    }
    result.listings.push(...listings);
  };

  for (const [lo, hi] of seeds) await visit(new PriceBand(lo, hi), box);

  log.info(
    `searchAnchorage: ${result.listings.length} results from ${result.queries} ` +
      `single-page queries (${result.unresolved.length} unresolved)`,
  );
  return result;
}

// --------------------------------------------------------------------------
// coverage audit

/** Number and size of the unfiltered boxes `auditCoverage` searches. */
export const COVERAGE_AUDIT_SAMPLE = 6;
const COVERAGE_AUDIT_BOX_LAT = 0.01; // ~1.1 km
const COVERAGE_AUDIT_BOX_LNG = 0.021; // ~1.1 km at 61N

/**
 * Result of `auditCoverage`. `missedIds` are listings an unfiltered box search
 * returned that the price bands did not.
 */
export interface CoverageAudit {
  boxes: number;
  seen: number;
  missedIds: bigint[];
}

export function emptyAudit(): CoverageAudit {
  return { boxes: 0, seen: 0, missedIds: [] };
}

export function missRate(audit: CoverageAudit): number {
  return audit.seen ? audit.missedIds.length / audit.seen : 0;
}

/**
 * mulberry32, seeded by scrape date, so re-running a day audits the same
 * boxes and different days audit different ones.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `k` distinct items, chosen by `random`. A partial Fisher-Yates shuffle. */
function sample<T>(items: readonly T[], k: number, random: () => number): T[] {
  const pool = [...items];
  const take = Math.min(k, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, take);
}

export interface AuditOptions {
  fetchPage: FetchPage;
  sampleSize?: number;
}

/**
 * Check that the price bands found every listing.
 *
 * Banding misses any listing without a price Airbnb filters on. This searches
 * a few small boxes with no price filter and reports listings they return
 * that the bands did not.
 *
 * Boxes are centered on found listings, since most of the bbox is uninhabited.
 * A box needing more than one page is skipped because its results are
 * unreliable.
 */
export async function auditCoverage(
  listings: readonly SearchListing[],
  scrapeDate: IsoDate,
  options: AuditOptions,
): Promise<CoverageAudit> {
  const foundIds = new Set(listings.map((listing) => listing.listingId));
  const located = listings.filter(
    (listing) => listing.latitude !== null && listing.longitude !== null,
  );
  const audit = emptyAudit();
  if (located.length === 0) return audit;

  const random = seededRandom(epochDays(scrapeDate));
  const centers = sample(located, options.sampleSize ?? COVERAGE_AUDIT_SAMPLE, random);

  for (const center of centers) {
    const lat = center.latitude!;
    const lng = center.longitude!;
    const box: BoundingBox = {
      swLat: lat - COVERAGE_AUDIT_BOX_LAT / 2,
      neLat: lat + COVERAGE_AUDIT_BOX_LAT / 2,
      swLng: lng - COVERAGE_AUDIT_BOX_LNG / 2,
      neLng: lng + COVERAGE_AUDIT_BOX_LNG / 2,
    };
    const { listings: rows, pageCount } = await options.fetchPage(null, box);
    if (pageCount > 1) {
      log.info(
        `coverage audit: box at ${lat.toFixed(4)},${lng.toFixed(4)} needs ` +
          `${pageCount} pages, skipping`,
      );
      continue;
    }
    const ids = new Set(rows.map((row) => row.listingId));
    audit.boxes += 1;
    audit.seen += ids.size;
    audit.missedIds.push(
      ...[...ids].filter((id) => !foundIds.has(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  log.info(
    `coverage audit: ${audit.boxes} boxes, ${audit.seen} listings seen, ` +
      `${audit.missedIds.length} missed by the price bands ` +
      `(${(missRate(audit) * 100).toFixed(1)}%)`,
  );
  return audit;
}
