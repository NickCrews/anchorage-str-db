/**
 * Search Anchorage as price bands narrow enough to each fit one page, then
 * check that claim a second, differently-shaped way.
 *
 * Airbnb's paginated search cannot be trusted twice over: it stops at 280
 * items without saying so, and it re-ranks between page fetches so that a
 * listing can appear on two pages while another appears on none. Both
 * defects live in pagination, and a query whose entire result set fits on
 * one page has neither — measured, such a query returns an identical set on
 * every repeat, while a seven-page query churns 69 listings between
 * identical calls.
 *
 * So this never paginates. It asks for one page, and if Airbnb says more
 * pages exist it halves the price band and asks again, until every query is
 * answerable in a single page. `pageCursors` reports the page count in the
 * same response, which makes completeness something the run reads off
 * Airbnb rather than infers.
 */

import {
  fetchSearchPage,
  standardizeSearchResponse,
  type BoundingBox,
  type SearchListing,
} from './airbnb/search.ts';
import * as config from './config.ts';
import { epochDays, type IsoDate } from './dates.ts';
import { log } from './log.ts';
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
   * Two abutting halves, or null if this band is one dollar wide.
   *
   * The halves share their boundary and that is correct, not a bug:
   * `price_max=X` and `price_min=X` are complementary, so a listing priced
   * exactly X lands in one half and only one. Measured on single-page
   * (deterministic) queries, splitting a 26-listing box at $100, $125, $150
   * and $200 gave below+above == 26 every time, with no duplicates and
   * nothing lost.
   */
  split(): [PriceBand, PriceBand] | null {
    if (this.maxUsd === null) {
      // Can't bisect an open interval; step the floor up instead.
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

/**
 * One request's worth of search. `pageCount` is what the caller narrows
 * against.
 */
export interface SearchPage {
  listings: SearchListing[];
  pageCount: number;
}

/**
 * One search page.
 *
 * Deliberately does not paginate. A result set that spans more than one
 * page is both silently truncatable at 280 items and re-ranked between
 * fetches, so the caller's job is to narrow the query until this returns a
 * single page rather than to walk the pages of a lying one.
 */
export type FetchPage = (band: PriceBand | null, box: BoundingBox) => Promise<SearchPage>;

/**
 * The live implementation of `FetchPage`, retried past Airbnb's intermittent
 * 5xx.
 *
 * A failed calendar or page fetch costs one listing's detail and is recorded
 * as such; a failed search page costs the entire pass, and with it the run,
 * because there is no partial search worth writing. So this retries where
 * those give up, and only raises once Airbnb has refused
 * `SEARCH_MAX_RETRIES` times in a row.
 *
 * A 429 is not a flaky 5xx and must not be retried: the block is IP-wide
 * and lasts on the order of an hour, so the retries only deepen it. The run
 * fails now, with the real reason.
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
 * One run's search pass.
 *
 * `unresolved` is what the quality gate cares about: bands that still needed
 * more than one page at the narrowest width price can express. A multi-page
 * query is both truncatable and non-deterministic, so those are listings we
 * cannot vouch for.
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
 * page.
 *
 * The geographic footprint stays exactly `box` throughout, which is what
 * lets the scrape's scope be checked against the municipality's real parcel
 * extents. Bands abut rather than overlap, so a listing is returned once;
 * the pipeline de-dupes anyway.
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
      // The parent's own page-1 sample is discarded in favour of the halves.
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
 * Result of re-asking for a sample of the market a different way.
 *
 * `missedIds` are listings an unfiltered box search returned that the price
 * bands did not. See `auditCoverage`.
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
 * A seeded PRNG — mulberry32 — so a run is reproducible but successive days
 * audit different neighbourhoods.
 *
 * Any small, stable generator does. Nothing depends on which listings get
 * sampled, only on the sample being a function of the scrape date alone, so
 * re-running a day audits the same boxes.
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
 * Second-opinion check that the price bands actually covered the market.
 *
 * Banding is exhaustive only if every listing carries a price Airbnb will
 * filter on. Nothing in the run can prove that from the inside: a band that
 * silently omits the unpriced returns a tidy, plausible result and the
 * union of tidy, plausible results looks complete. So this asks the same
 * question in a shape that has no price filter at all — a handful of small
 * bounding boxes drawn around listings we did find — and reports anything
 * those boxes return that the bands did not.
 *
 * Boxes are centred on known listings rather than sampled uniformly over
 * the bbox, because most of the bbox is mountain and would audit nothing.
 * A box needing more than one page is skipped, not counted: a multi-page
 * answer is both truncatable and unstable, so it cannot testify about what
 * is missing.
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
