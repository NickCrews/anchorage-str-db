/**
 * Search Anchorage in price bands narrow enough that each fits on one page,
 * then audit coverage with a differently shaped query.
 *
 * Airbnb's paginated search silently stops at 280 items and re-ranks between
 * page fetches, so listings are duplicated or skipped. A single-page query
 * has neither problem. This module never paginates: when a response reports
 * more than one page (`pageCursors`), it halves the price band and retries.
 */

import { epochDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { log } from '@anchorage-str-db/utils/log';

import {
  fetchSearchPage,
  standardizeSearchResponse,
  type BoundingBox,
  type SearchListing,
} from './api/search.ts';
import * as config from './config.ts';
import { withRetries } from './retry.ts';

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
    if (this.width <= config.PRICE_BAND_MIN_WIDTH_USD) return null;
    const mid = Math.floor((this.minUsd + this.maxUsd) / 2);
    return [new PriceBand(this.minUsd, mid), new PriceBand(mid, this.maxUsd)];
  }

  toString(): string {
    return `$${this.minUsd}-${this.maxUsd ?? 'inf'}`;
  }
}

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
          zoom: config.ZOOM_VALUE,
          currency: config.CURRENCY,
          language: config.LANGUAGE,
          priceMinUsd: band?.minUsd,
          priceMaxUsd: band?.maxUsd ?? undefined,
        });
        const { listings, pageCount } = standardizeSearchResponse(raw);
        return { listings, pageCount };
      },
      {
        label: 'search page',
        attempts: config.SEARCH_MAX_RETRIES,
        backoffMs: config.SEARCH_RETRY_BACKOFF_MS,
        onRetry: (err, attempt) => {
          log.warn(`search page failed (attempt ${attempt}), retrying: ${String(err)}`);
        },
      },
    );
}

/**
 * One run's search pass. `unresolved` lists bands that still needed more than
 * one page at minimum width, so their results may be incomplete.
 */
export interface SearchResult {
  listings: SearchListing[];
  queries: number;
  unresolved: PriceBand[];
}

export interface SearchOptions {
  fetchPage: FetchPage;
  box?: BoundingBox;
  seeds?: ReadonlyArray<readonly [number, number | null]>;
}

/**
 * Search the whole box, splitting by price until no query needs a second
 * page. Every query uses the same `box`, so the scrape's scope is exactly the
 * box tested against parcel extents in `config.test.ts`.
 */
export async function searchAnchorage(options: SearchOptions): Promise<SearchResult> {
  const box = options.box ?? config.BBOX;
  const seeds = options.seeds ?? config.PRICE_BAND_SEEDS_USD;
  const result: SearchResult = { listings: [], queries: 0, unresolved: [] };

  const visit = async (band: PriceBand): Promise<void> => {
    const { listings, pageCount } = await options.fetchPage(band, box);
    result.queries += 1;
    const halves = pageCount > 1 ? band.split() : null;
    log.info(
      `search: ${band} -> ${listings.length} results across ${pageCount} page(s)` +
        (halves ? ' (splitting)' : ''),
    );
    if (halves) {
      // The parent's partial page is discarded; the halves replace it.
      for (const half of halves) await visit(half);
      return;
    }
    if (pageCount > 1) {
      log.warn(
        `search: ${band} still needs ${pageCount} pages and is too narrow to split — ` +
          `more than ${config.SEARCH_PAGE_SIZE} listings at one price, which price ` +
          'cannot separate',
      );
      result.unresolved.push(band);
    }
    result.listings.push(...listings);
  };

  for (const [lo, hi] of seeds) await visit(new PriceBand(lo, hi));

  log.info(
    `searchAnchorage: ${result.listings.length} results from ${result.queries} ` +
      `single-page queries (${result.unresolved.length} unresolved)`,
  );
  return result;
}

// --------------------------------------------------------------------------
// coverage audit

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
 * Boxes are centred on found listings, since most of the bbox is uninhabited.
 * A box needing more than one page is skipped because its results are
 * unreliable.
 */
export async function auditCoverage(
  listings: readonly SearchListing[],
  scrapeDate: IsoDate,
  options: AuditOptions,
): Promise<CoverageAudit> {
  const foundIds = new Set(listings.map((listing) => listing.roomId));
  const located = listings.filter(
    (listing) => listing.latitude !== null && listing.longitude !== null,
  );
  const audit = emptyAudit();
  if (located.length === 0) return audit;

  const random = seededRandom(epochDays(scrapeDate));
  const centres = sample(located, options.sampleSize ?? config.COVERAGE_AUDIT_SAMPLE, random);

  for (const centre of centres) {
    const lat = centre.latitude!;
    const lng = centre.longitude!;
    const box: BoundingBox = {
      swLat: lat - config.COVERAGE_AUDIT_BOX_LAT / 2,
      neLat: lat + config.COVERAGE_AUDIT_BOX_LAT / 2,
      swLng: lng - config.COVERAGE_AUDIT_BOX_LNG / 2,
      neLng: lng + config.COVERAGE_AUDIT_BOX_LNG / 2,
    };
    const { listings: rows, pageCount } = await options.fetchPage(null, box);
    if (pageCount > 1) {
      log.info(
        `coverage audit: box at ${lat.toFixed(4)},${lng.toFixed(4)} needs ` +
          `${pageCount} pages, skipping`,
      );
      continue;
    }
    const ids = new Set(rows.map((row) => row.roomId));
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
