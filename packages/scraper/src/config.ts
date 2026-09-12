/**
 * Constants for the Anchorage STR scraper.
 *
 * The bounding box is not eyeballed off a map — it's intended to cover the
 * Municipality of Anchorage footprint, including Anchorage Bowl and
 * Girdwood. Tune these bounds against fresh parcel extents from
 * https://github.com/NickCrews/anchorage-property as needed.
 *
 *     duckdb -c "
 *       ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS parcels_db (READ_ONLY);
 *       SELECT min(centroid_lon), max(centroid_lon), min(centroid_lat), max(centroid_lat)
 *         FROM parcels_db.parcels_current;"
 */

import type { BoundingBox } from './airbnb/search.ts';

/**
 * The Municipality of Anchorage's real parcel extents, measured from the
 * 98,550 parcels in anchorage-property with the query in the module
 * docstring. `BBOX` must contain this with room to spare, and
 * `test/config.test.ts` asserts that it does — the box is the scrape's
 * entire definition of "Anchorage", so a box that clips is an undercount no
 * downstream check can see.
 */
export const MUNICIPALITY_EXTENT: BoundingBox = {
  swLat: 60.7837,
  swLng: -150.2417,
  neLat: 61.4833,
  neLng: -148.8448,
};

/**
 * Municipality-wide Anchorage bounds, padded past MUNICIPALITY_EXTENT on
 * every side. Listings outside the box are not "missing", they are never
 * asked about, so a box that clips even a few parcels undercounts silently.
 */
export const BBOX: BoundingBox = {
  swLat: 60.77,
  swLng: -150.35,
  neLat: 61.5,
  neLng: -148.8,
};

/**
 * Sent through to Airbnb's map search for realism, but it does not change
 * what comes back: the same box returns an identical result set at zoom 11
 * through 15 (measured). The bounding box alone selects the listings, which
 * is why the result cap below is worked around by splitting the search and
 * not by zooming in.
 */
export const ZOOM_VALUE = 11;

/**
 * Airbnb's search is only deterministic when the whole result set fits on
 * one page.
 *
 * Two separate defects make a paginated search lie, and both are fixed by
 * never paginating:
 *
 * 1. It stops at 280 items however many match, and says nothing: the last
 *    page it will serve reports `nextPageCursor: null`, exactly like a
 *    genuinely exhausted search. One Anchorage-wide query returned ~250
 *    listings out of ~2600 and looked complete. (The limit is on items, not
 *    pages — `itemsPerGrid=20` yields 14 pages, 40 yields 7.)
 *
 * 2. It re-ranks between page fetches, so the same listing lands on two
 *    pages while another is skipped entirely. Churn measured against the
 *    number of pages, three identical queries each:
 *
 *        1 page  ->  0 listings churned
 *        3 pages -> 10-20 churned
 *        5 pages -> 27-32 churned
 *        7 pages -> 69 churned
 *
 * A single-page query has neither problem: nothing is truncated and there
 * is no second page to shuffle against. Measured, a one-page query returns
 * a byte-for-byte identical *set* on every repeat.
 *
 * So `searchAnchorage` splits by price until every query fits one page, and
 * then issues exactly one request per band. `pageCursors` in the response
 * says how many pages exist, which makes "did this query tell me the
 * truth?" a property the run reads rather than infers.
 *
 * The measurements behind all of this, and the alternatives that were tried
 * and rejected (a stable sort key, larger pages, a map endpoint, text
 * search), are in docs/research/airbnb-search-pagination.md. Read it before
 * changing how the search is partitioned; otherwise it is not needed.
 */
export const SEARCH_PAGE_SIZE = 40;

/**
 * Price bands abut exactly — no overlap. `price_max=X` and `price_min=X`
 * are complementary: measured on single-page queries, splitting a
 * 26-listing box at $100/$125/$150/$200 gave below+above == 26 every time,
 * with zero duplicates and zero gap.
 *
 * Measure a boundary only on a single-page query. On a multi-page one,
 * pagination churn drops listings between pages and looks exactly like a gap
 * at the split, which would argue for overlapping bands that are not needed.
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
 * A band of this width cannot be split further. A $1 band that still needs
 * more than one page would mean more than 40 listings at a single price,
 * which price can no longer separate; the `search_single_page` check fails
 * the run rather than let the undercount pass as a complete scrape.
 * Measured, the densest $1-2 bands in Anchorage (around the round numbers
 * $150, $200) return 36 of a possible 40, so there is headroom but not a
 * lot.
 */
export const PRICE_BAND_MIN_WIDTH_USD = 1;

/**
 * Retries per search page, mirroring CALENDAR_MAX_RETRIES. Airbnb returns
 * an occasional 500 that succeeds on the next attempt. Unlike a failed
 * calendar or page fetch, which costs one listing's detail, an unretried
 * search failure aborts the whole pass and with it the day's run — so this
 * pass is the one that can least afford to give up on the first error.
 */
export const SEARCH_MAX_RETRIES = 4;

/**
 * Coverage audit (see `auditCoverage`). Price banding is only exhaustive if
 * every listing carries a price Airbnb will filter on, and no amount of
 * unit testing can confirm that against a live API. So each run re-searches
 * a few small boxes around listings it already found, using a completely
 * different query shape — a bbox with no price filter — and checks that
 * everything those boxes return was in fact found. It is an independent
 * second opinion, not a second enumeration: a handful of queries, not
 * another full pass.
 */
export const COVERAGE_AUDIT_SAMPLE = 6;
export const COVERAGE_AUDIT_BOX_LAT = 0.01; // ~1.1 km
export const COVERAGE_AUDIT_BOX_LNG = 0.021; // ~1.1 km at 61N

/**
 * Fraction of audit-box listings the main pass may miss before the run
 * fails.
 *
 * The measured rate is 0% (4 usable boxes, 68 listings, 0 missed — 2 of the
 * 6 sampled boxes needed more than one page and were skipped as
 * untrustworthy), while a search that paginates misses ~8%.
 *
 * So the threshold is a tripwire rather than a tolerance. It is not zero
 * only because the audit and the search ask in different shapes and Airbnb
 * is not obliged to be perfectly consistent between them; anything
 * approaching this number means the price bands have stopped covering the
 * market.
 */
export const MAX_COVERAGE_MISS_RATE = 0.05;

export const CURRENCY = 'USD';
export const LANGUAGE = 'en';

/**
 * The whole run's request budget, in requests per second, shared by the
 * search, the page pass and the calendar pass. See `pace.ts` for the
 * measurements; the short version is that Airbnb counts *requests per IP
 * over a rolling window* (~130 per ~60s) and does not care how fast you got
 * there, so one global rate is the only knob that corresponds to anything
 * real.
 *
 * Calibration: 1400 requests held at 2.0/s ran 11.7 minutes with zero 429s.
 * The ceiling inferred from three separate trips is ~2.2/s. This sits under
 * both, because overshooting is not a little slower — it is either a stall
 * (measured at 4/s: connections simply stop answering) or an IP-wide ban
 * lasting on the order of an hour (measured at 17/s).
 *
 * At 1.8/s a full run — ~190 search requests plus ~2600 pages plus ~2600
 * calendars — is about 50 minutes. Raising this is not the way to make it
 * much faster; making the page pass ask for fewer listings is (see
 * docs/research/airbnb-rate-limits.md).
 */
export const REQUESTS_PER_SECOND = 1.8;

/**
 * How many sockets may be open at once. This is only a concurrency cap —
 * `REQUESTS_PER_SECOND` sets the pace — so it wants to be high enough to
 * keep the rate achievable given ~0.9s per request, and no higher.
 */
export const CALENDAR_CONCURRENCY = 6;
export const CALENDAR_MAX_RETRIES = 3;

export const DEFAULT_DB_PATH = 'data/anchorage_str.duckdb';

/**
 * A listing absent from search results for this many consecutive days is
 * considered delisted, and `listings.is_current` goes false. Longer than a couple
 * of days on purpose: Airbnb's map search is occasionally flaky, and a
 * listing blinking out for a day shouldn't read as "this STR closed."
 */
export const RETIREMENT_GRACE_DAYS = 5;

/**
 * Data-quality gate: a run is rejected if the listing count observed falls
 * outside this band. A count outside it more likely reflects a broken bbox,
 * a blocked scrape, or an Airbnb API change than a real market swing.
 *
 * The floor is deliberately well above the ~280 a single un-split query can
 * return, so a search that has silently collapsed to one capped query (see
 * SEARCH_PAGE_SIZE) fails here instead of reading as a small market. Widen
 * the band as real history gives a better sense of natural variance.
 */
export const PLAUSIBLE_LISTING_COUNT: readonly [number, number] = [1000, 8000];

/**
 * A run's calendar-fetch failure rate above this fraction fails the
 * data-quality gate — a few flaky requests are normal, a third of them
 * failing usually means Airbnb rate-limited or blocked this run.
 */
export const MAX_CALENDAR_FAILURE_RATE = 0.25;

/**
 * Per-listing page (PDP) fetches, used by `listingPage.ts` to read the
 * location payload and STR registration number. Same politeness budget as
 * the calendar pass, and deliberately a separate set of knobs: this is a
 * full HTML page (~500 KB) per listing rather than a small JSON response,
 * so it may need to be throttled independently if Airbnb starts objecting.
 */
export const PAGE_CONCURRENCY = 6;
export const PAGE_MAX_RETRIES = 3;

/**
 * Shorter than it looks: a request that has hung this long is not slow, it
 * is the limiter stalling us (see `Pacer.noteTimeout`), and the sooner that
 * is recognised the sooner the rate comes down. A long timeout leaves every
 * worker parked before the backoff can react.
 */
export const PAGE_TIMEOUT_MS = 15_000;

/**
 * A listing-page pass with a failure rate above this fraction fails the
 * data-quality gate, mirroring MAX_CALENDAR_FAILURE_RATE.
 */
export const MAX_PAGE_FAILURE_RATE = 0.25;

/** Backoff between retries of a failed fetch: `RETRY_BACKOFF_MS * attempt`. */
export const RETRY_BACKOFF_MS = 500;

/** The search pass waits longer between attempts, since it retries more. */
export const SEARCH_RETRY_BACKOFF_MS = 1500;
