/**
 * Constants for the Airbnb scraper.
 *
 * The bounding box covers the Municipality of Anchorage, including Girdwood,
 * and is derived from parcel extents in
 * https://github.com/NickCrews/anchorage-property:
 *
 *     duckdb -c "
 *       ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS parcels_db (READ_ONLY);
 *       SELECT min(centroid_lon), max(centroid_lon), min(centroid_lat), max(centroid_lat)
 *         FROM parcels_db.parcels_current;"
 */

import type { BoundingBox } from './api/search.ts';

/**
 * Parcel extents of the Municipality of Anchorage (98,550 parcels), from the
 * query in the module docstring. `test/config.test.ts` asserts `BBOX`
 * contains it.
 */
export const MUNICIPALITY_EXTENT: BoundingBox = {
  swLat: 60.7837,
  swLng: -150.2417,
  neLat: 61.4833,
  neLng: -148.8448,
};

/**
 * The search area: MUNICIPALITY_EXTENT padded on every side. Listings outside
 * it are never searched, so an undersized box undercounts without any error.
 */
export const BBOX: BoundingBox = {
  swLat: 60.77,
  swLng: -150.35,
  neLat: 61.5,
  neLng: -148.8,
};

/**
 * Sent to Airbnb's map search but has no effect on results: zoom 11 through
 * 15 return identical sets for the same box.
 */
export const ZOOM_VALUE = 11;

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
export const SEARCH_PAGE_SIZE = 40;

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

/**
 * Bands this narrow are not split further. One that still needs more than a
 * page (over 40 listings at one price) fails the `search_single_page` check.
 * The densest $1-2 bands (around $150 and $200) return 36 listings.
 */
export const PRICE_BAND_MIN_WIDTH_USD = 1;

/**
 * Attempts per search page. Higher than the per-listing passes because a
 * failed search page fails the run, while Airbnb's occasional 500 usually
 * succeeds on retry.
 */
export const SEARCH_MAX_RETRIES = 4;

/** Coverage audit: number and size of the unfiltered boxes `auditCoverage` searches. */
export const COVERAGE_AUDIT_SAMPLE = 6;
export const COVERAGE_AUDIT_BOX_LAT = 0.01; // ~1.1 km
export const COVERAGE_AUDIT_BOX_LNG = 0.021; // ~1.1 km at 61N

export const CURRENCY = 'USD';
export const LANGUAGE = 'en';

/**
 * Request rate shared by every pass. Airbnb limits each IP to ~130 requests
 * per ~60s rolling window (see `pace.ts`), a ceiling of ~2.2/s; 2.0/s held for
 * 1400 requests with no 429s. Exceeding it stalls connections (4/s) or bans
 * the IP for an hour or more (17/s).
 *
 * At 1.8/s a full run is about 50 minutes. Fetching fewer listing pages would
 * shorten it more than raising this (see docs/research/airbnb-rate-limits.md).
 */
export const REQUESTS_PER_SECOND = 1.8;

/**
 * Maximum concurrent calendar requests. `REQUESTS_PER_SECOND` sets the rate;
 * this only needs to be high enough to reach it at ~0.9s per request.
 */
export const CALENDAR_CONCURRENCY = 6;
export const CALENDAR_MAX_RETRIES = 3;

/** Concurrency, attempts and timeout for price quotes (`priceQuotes.ts`). */
export const QUOTE_CONCURRENCY = 6;
export const QUOTE_MAX_RETRIES = 3;
export const QUOTE_TIMEOUT_MS = 15_000;

/** Concurrency and attempts for listing-page fetches (`listingPage.ts`). */
export const PAGE_CONCURRENCY = 6;
export const PAGE_MAX_RETRIES = 3;

/**
 * A request this slow is usually the rate limiter stalling connections, so a
 * short timeout lets `Pacer.noteTimeout` lower the rate sooner.
 */
export const PAGE_TIMEOUT_MS = 15_000;

/**
 * Listings whose earliest review date is resolved per run (`firstReviews.ts`).
 *
 * Each listing is resolved once, so in steady state a run resolves only the
 * few listings new that day. The first runs backfill the ~2600 existing
 * listings; at 1000 per run that takes ~3 days and adds ~1030 requests
 * (~10 minutes at `REQUESTS_PER_SECOND`) to each, well inside the CI
 * timeout.
 */
export const FIRST_REVIEW_MAX_PER_RUN = 1000;
export const FIRST_REVIEW_CONCURRENCY = 6;
export const FIRST_REVIEW_MAX_RETRIES = 3;

/** Backoff between retries of a failed fetch: `RETRY_BACKOFF_MS * attempt`. */
export const RETRY_BACKOFF_MS = 500;

/** Backoff for search retries, which are more numerous. */
export const SEARCH_RETRY_BACKOFF_MS = 1500;
