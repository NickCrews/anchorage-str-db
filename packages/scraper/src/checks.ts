/**
 * Data-quality checks run after each day's writes. Any failed error-severity
 * check makes the run exit non-zero, which blocks publishing.
 */

import type { Database } from '@anchorage-str-db/db/database';
import { missRate, type CoverageAudit, type SearchResult } from '@anchorage-str-db/scraper-airbnb/search';
import type { IsoDate } from '@anchorage-str-db/utils/dates';
import { log } from '@anchorage-str-db/utils/log';
import { inMunicipality } from '@anchorage-str-db/utils/muni_geography';

import type { PageFetchStats, QuoteStats } from './store.ts';

/**
 * A run fails if the current listing count is outside this range, which
 * suggests a broken bbox, a blocked scrape, or an API change. The floor is
 * well above the 280 a single unsplit query returns.
 */
export const PLAUSIBLE_LISTING_COUNT: readonly [number, number] = [1000, 8000];

/**
 * Fraction of audit-box listings the price bands may miss before the run
 * fails. The measured rate is 0% (68 listings in 4 usable boxes); a
 * paginating search misses ~8%. Non-zero to allow minor inconsistency between
 * the two query shapes.
 */
const MAX_COVERAGE_MISS_RATE = 0.05;

/** A calendar-fetch failure rate above this fails the run. */
const MAX_CALENDAR_FAILURE_RATE = 0.25;

/** A listing-page failure rate above this fails the run. */
const MAX_PAGE_FAILURE_RATE = 0.25;

/**
 * The share of current, page-read listings with a value below which the run
 * fails, for each page field every listing has: `host_id`, `room_type`,
 * `guest_capacity`, `beds`, `bathrooms`, and photos. Every real page sampled
 * (41 for the host, 44 for the rest) yielded each one, so a shortfall means
 * the extraction broke. `registryChecks.ts` holds license pages to the same
 * share.
 */
export const MIN_PAGE_FIELD_SHARE = 0.95;

/**
 * The same for `bedrooms`, which rooms and some campers omit: 33 of 44
 * sampled pages had a bedroom or studio line.
 */
const MIN_BEDROOMS_SHARE = 0.6;

/** A price-quote failure rate above this fails the run. */
const MAX_QUOTE_FAILURE_RATE = 0.25;

/**
 * The share of quotes read without error that carry a price, below which the
 * run fails. A quote can lack one when a stay was booked between the calendar
 * fetch and the quote, or Airbnb's advance-notice rules block it.
 */
const MIN_QUOTE_PRICE_SHARE = 0.8;

/**
 * A first-review failure rate above this fails the `first_review_failure_rate`
 * check, at warn severity.
 */
const MAX_FIRST_REVIEW_FAILURE_RATE = 0.25;

/**
 * Warn-severity gates on the host dimension. A failed page is the ordinary
 * cause of an unread card, so the failure rate mirrors
 * `MAX_PAGE_FAILURE_RATE`. The views carry each host's last read forward, so
 * only hosts never once read can lack a profile; 2616 of 2618 pages measured
 * yielded a card.
 */
const MAX_HOST_PROFILE_FAILURE_RATE = 0.25;
const MIN_HOST_PROFILE_SHARE = 0.95;

/**
 * How far the start dates implied by one host's `timeAsHost` readings may
 * spread before `host_start_date_stable` warns. Readings in whole months
 * taken on different days of the month disagree by up to about a month.
 */
const HOST_START_MAX_SPREAD_DAYS = 45;

export type Severity = 'error' | 'warn';

export interface CheckResult {
  name: string;
  severity: Severity;
  passed: boolean;
  detail: string;
}

export interface CheckInputs {
  /** In-memory stats from this run's passes, which are not stored in the database. */
  pageStats: PageFetchStats;
  quoteStats: QuoteStats;
  searchResult: SearchResult;
  coverage: CoverageAudit;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export async function runChecks(
  db: Database,
  scrapeDate: IsoDate,
  inputs: CheckInputs,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, severity: Severity, passed: boolean, detail: string): void => {
    results.push({ name, severity, passed, detail });
  };

  // A band still needing multiple pages may have been truncated or
  // reshuffled (see `searchAnchorage`).
  const unresolved = inputs.searchResult.unresolved;
  check(
    'search_single_page',
    'error',
    unresolved.length === 0,
    `${unresolved.length} price bands still needed more than one page at the narrowest ` +
      'width price can express' +
      (unresolved.length ? `: ${unresolved.slice(0, 5).map(String).join(', ')}` : ''),
  );

  // Catches listings the price bands miss entirely, e.g. ones with no
  // filterable price (see `auditCoverage`).
  const coverage = inputs.coverage;
  if (coverage.boxes) {
    const rate = missRate(coverage);
    check(
      'search_coverage',
      'error',
      rate <= MAX_COVERAGE_MISS_RATE,
      `${coverage.missedIds.length}/${coverage.seen} listings in ${coverage.boxes} audit ` +
        `boxes were missed by the price bands (${percent(rate)}, max ` +
        `${percent(MAX_COVERAGE_MISS_RATE)})` +
        (coverage.missedIds.length ? `; e.g. ${coverage.missedIds.slice(0, 5).join(', ')}` : ''),
    );
  } else {
    // No usable audit boxes; report it rather than passing silently.
    check('search_coverage', 'warn', false, 'coverage audit did not run: no usable audit boxes');
  }

  const currentCount = await db.count('SELECT count(*) FROM listings WHERE is_current');
  const [lo, hi] = PLAUSIBLE_LISTING_COUNT;
  check(
    'listing_count_plausible',
    'error',
    lo <= currentCount && currentCount <= hi,
    `${currentCount} current listings, expected [${lo}, ${hi}]`,
  );

  // This and the overlap check test the SCD2 logic in the `listings` view.
  const dupes = await db.count(
    'SELECT count(*) FROM (SELECT listing_id FROM listings WHERE is_current ' +
      'GROUP BY listing_id HAVING count(*) > 1)',
  );
  check(
    'no_duplicate_current_listings',
    'error',
    dupes === 0,
    `${dupes} listing_ids with >1 current row`,
  );

  const overlap = await db.count(`
    SELECT count(*) FROM listings a JOIN listings b
      ON a.listing_id = b.listing_id AND a.valid_from < b.valid_from
    WHERE a.valid_to IS NULL OR a.valid_to > b.valid_from
  `);
  check(
    'no_overlapping_listing_versions',
    'error',
    overlap === 0,
    `${overlap} overlapping SCD2 intervals`,
  );

  // The pipeline drops listings outside the boundary before storing them, so
  // this finds listings with no coordinates, and listings stored before the
  // boundary last changed that have not yet retired (RETIREMENT_GRACE_DAYS).
  const coords = await db.rows<{ listing_id: string; lat: number | null; lng: number | null }>(
    'SELECT listing_id, location_lat AS lat, location_lng AS lng FROM listings ' +
      'WHERE is_current ORDER BY listing_id',
  );
  const outside = coords.filter(
    ({ lat, lng }) => lat === null || lng === null || !inMunicipality(lat, lng),
  );
  check(
    'coords_within_municipality',
    'warn',
    outside.length === 0,
    `${outside.length} current listings with no coordinates or outside the Municipality` +
      (outside.length ? `; e.g. ${outside.slice(0, 5).map((row) => row.listing_id).join(', ')}` : ''),
  );

  const runs = await db.rows<{
    calendar_fetch_attempted: number | null;
    calendar_fetch_failed: number | null;
    first_review_fetch_attempted: number | null;
    first_review_fetch_failed: number | null;
  }>(
    'SELECT calendar_fetch_attempted, calendar_fetch_failed, ' +
      'first_review_fetch_attempted, first_review_fetch_failed FROM airbnb_scrape_runs ' +
      'WHERE scrape_date = CAST(? AS DATE) ORDER BY run_started_at DESC LIMIT 1',
    [scrapeDate],
  );
  const run = runs[0];
  if (run) {
    const attempted = run.calendar_fetch_attempted ?? 0;
    const failed = run.calendar_fetch_failed ?? 0;
    const rate = attempted ? failed / attempted : 0;
    check(
      'calendar_failure_rate',
      'error',
      rate <= MAX_CALENDAR_FAILURE_RATE,
      `${failed}/${attempted} calendar fetches failed (${percent(rate)})`,
    );
  } else {
    check('calendar_failure_rate', 'error', false, 'no airbnb_scrape_runs row found for this scrape_date');
  }

  // A warning: a failed listing writes nothing and is retried next run, so
  // failing the run would withhold the day's calendar and listings, which
  // can't be re-scraped later, to protect review dates, which can.
  const reviewsAttempted = run?.first_review_fetch_attempted ?? 0;
  if (reviewsAttempted) {
    const failed = run?.first_review_fetch_failed ?? 0;
    const rate = failed / reviewsAttempted;
    check(
      'first_review_failure_rate',
      'warn',
      rate <= MAX_FIRST_REVIEW_FAILURE_RATE,
      `${failed}/${reviewsAttempted} first-review fetches failed (${percent(rate)}, max ` +
        `${percent(MAX_FIRST_REVIEW_FAILURE_RATE)})`,
    );
  }

  const freshness = await db.count(
    'SELECT count(*) FROM airbnb_listing_observations WHERE scrape_date = CAST(? AS DATE)',
    [scrapeDate],
  );
  check(
    'observations_written_today',
    'error',
    freshness > 0,
    `${freshness} airbnb_listing_observations rows for ${scrapeDate}`,
  );

  // Zero attempts means no listings, which `listing_count_plausible` reports.
  const pageStats = inputs.pageStats;
  if (pageStats.attempted) {
    const rate = pageStats.failed / pageStats.attempted;
    check(
      'listing_page_failure_rate',
      'error',
      rate <= MAX_PAGE_FAILURE_RATE,
      `${pageStats.failed}/${pageStats.attempted} listing-page fetches failed (${percent(rate)})`,
    );
  }

  const fetched = pageStats.attempted - pageStats.failed;
  if (fetched) {
    // Only the `state` layer yields `isExactLocation`, so none present means
    // that layer broke.
    check(
      'exact_location_flag_present',
      'error',
      pageStats.withExactFlag > 0,
      `${pageStats.withExactFlag}/${fetched} pages read this run carried isExactLocation`,
    );

    // Read from this run's pages rather than `airbnb_listing_photos`, which
    // keeps the previous set current when a page yields none and so would hide
    // a broken extraction.
    const photoShare = pageStats.withPhotos / fetched;
    check(
      'photo_coverage',
      'error',
      photoShare >= MIN_PAGE_FIELD_SHARE,
      `${pageStats.withPhotos}/${fetched} pages read this run had photos ` +
        `(${percent(photoShare)}, min ${percent(MIN_PAGE_FIELD_SHARE)})`,
    );

    // Warn when an extraction layer contributed to no pages. See listingPage.ts.
    for (const layer of ['json-ld', 'state'] as const) {
      const live = pageStats.layerUsed[layer];
      check(
        `extraction_layer_${layer.replace('-', '_')}_alive`,
        'warn',
        live > 0,
        `${live}/${fetched} pages read this run used the ${layer} layer`,
      );
    }
  }

  // Errors, not warnings: these fields are in the version key, so a parse that
  // stops finding one stores NULL, which opens a spurious version for every
  // affected listing, and again when the parser is fixed. Failing the run
  // keeps that day out of the published archive.
  const minShare = MIN_PAGE_FIELD_SHARE;
  const pageRead = await db.count(
    'SELECT count(*) FROM listings WHERE is_current AND page_seen_date IS NOT NULL',
  );
  if (pageRead) {
    const minimums = [
      ['host_id', minShare],
      ['room_type', minShare],
      ['guest_capacity', minShare],
      ['beds', minShare],
      ['bedrooms', MIN_BEDROOMS_SHARE],
      ['bathrooms', minShare],
    ] as const;
    for (const [column, min] of minimums) {
      const present = await db.count(
        'SELECT count(*) FROM listings ' +
          `WHERE is_current AND page_seen_date IS NOT NULL AND ${column} IS NOT NULL`,
      );
      const share = present / pageRead;
      check(
        `${column}_coverage`,
        'error',
        share >= min,
        `${present}/${pageRead} current listings with a page read have a ${column} ` +
          `(${percent(share)}, min ${percent(min)})`,
      );
    }
  }

  // From this run's quotes, like the page-pass checks. A quote is not part of
  // the version key, so a broken pass costs only that day's prices; failing
  // the run still keeps it from going unnoticed.
  const quoteStats = inputs.quoteStats;
  if (quoteStats.attempted) {
    const failureRate = quoteStats.failed / quoteStats.attempted;
    check(
      'price_quote_failure_rate',
      'error',
      failureRate <= MAX_QUOTE_FAILURE_RATE,
      `${quoteStats.failed}/${quoteStats.attempted} price quotes failed (${percent(failureRate)})`,
    );
    const read = quoteStats.attempted - quoteStats.failed;
    if (read) {
      const pricedShare = quoteStats.priced / read;
      check(
        'price_quote_priced',
        'error',
        pricedShare >= MIN_QUOTE_PRICE_SHARE,
        `${quoteStats.priced}/${read} price quotes read carried a price ` +
          `(${percent(pricedShare)}, min ${percent(MIN_QUOTE_PRICE_SHARE)})`,
      );
    }
  }

  // Warnings, not errors: the views carry every host's last good read
  // forward, so a day without fresh profiles is thinner, not wrong.
  // `listing_page_failure_rate` already errors when pages stop arriving, so
  // these isolate the host card's extraction breaking.
  const hostRuns = await db.rows<{
    host_profile_attempted: number | null;
    host_profile_failed: number | null;
  }>(
    'SELECT host_profile_attempted, host_profile_failed FROM airbnb_scrape_runs ' +
      'WHERE scrape_date = CAST(? AS DATE) ORDER BY run_started_at DESC LIMIT 1',
    [scrapeDate],
  );
  const hostAttempted = hostRuns[0]?.host_profile_attempted ?? 0;
  if (hostAttempted) {
    const hostFailed = hostRuns[0]?.host_profile_failed ?? 0;
    const rate = hostFailed / hostAttempted;
    check(
      'host_profile_failure_rate',
      'warn',
      rate <= MAX_HOST_PROFILE_FAILURE_RATE,
      `${hostFailed}/${hostAttempted} hosts with a listing observed today had no host card ` +
        `read (${percent(rate)}, max ${percent(MAX_HOST_PROFILE_FAILURE_RATE)})`,
    );
  }

  // Listings with no host_id at all are `host_id_coverage`'s concern.
  const owned = await db.count(
    'SELECT count(*) FROM listings WHERE is_current AND host_id IS NOT NULL',
  );
  if (owned) {
    const resolved = await db.count(
      'SELECT count(*) FROM listings l ' +
        'JOIN hosts h ON h.host_id = l.host_id AND h.valid_to IS NULL ' +
        'WHERE l.is_current AND h.profile_seen_date IS NOT NULL',
    );
    const share = resolved / owned;
    check(
      'host_profile_coverage',
      'warn',
      share >= MIN_HOST_PROFILE_SHARE,
      `${resolved}/${owned} current listings with a host_id resolve to a read host profile ` +
        `(${percent(share)}, min ${percent(MIN_HOST_PROFILE_SHARE)})`,
    );
  }

  // A hosting start date should never move. Month rounding is within the
  // threshold; beyond it is an account change or a parse reading the wrong
  // number.
  const moved = await db.rows<{ host_id: string; spread: number }>(
    'SELECT host_id, hosting_start_spread_days AS spread FROM hosts ' +
      'WHERE is_current AND hosting_start_spread_days > ? ORDER BY spread DESC',
    [HOST_START_MAX_SPREAD_DAYS],
  );
  check(
    'host_start_date_stable',
    'warn',
    moved.length === 0,
    `${moved.length} current hosts whose hosting start date moved by more than ` +
      `${HOST_START_MAX_SPREAD_DAYS} days between readings` +
      (moved.length
        ? `; e.g. ${moved.slice(0, 5).map((row) => `${row.host_id} (${row.spread}d)`).join(', ')}`
        : ''),
  );

  // Airbnb emits exact coordinates at 4 decimal places and jittered ones at
  // 5+ (41/41 measured; see docs/research/airbnb-pdp-location-payload.md).
  // This is undocumented, so a mismatch warns rather than fails.
  const mismatched = await db.count(`
    SELECT count(*) FROM listings
    WHERE is_current AND location_is_exact IS NOT NULL AND location_lat IS NOT NULL
      AND location_is_exact != (
          length(split_part(abs(location_lat)::VARCHAR, '.', 2)) <= 4
          AND length(split_part(abs(location_lng)::VARCHAR, '.', 2)) <= 4
      )
  `);
  const located = await db.count(
    'SELECT count(*) FROM listings WHERE is_current AND location_is_exact IS NOT NULL',
  );
  if (located) {
    check(
      'exact_flag_matches_coordinate_precision',
      'warn',
      mismatched / located <= 0.05,
      `${mismatched}/${located} listings where isExactLocation disagrees with ` +
        'the 4-vs-5-decimal-place signal',
    );
  }

  // A night before its own valid_from is an elapsed day that `toNights`
  // should have dropped.
  const backdated = await db.count(
    'SELECT count(*) FROM airbnb_calendar_status WHERE night_date < valid_from',
  );
  check(
    'no_backdated_calendar_rows',
    'error',
    backdated === 0,
    `${backdated} airbnb_calendar_status rows with night_date before their own valid_from`,
  );

  return results;
}

/** Log every check; return true iff no error-severity check failed. */
export function report(results: readonly CheckResult[]): boolean {
  let ok = true;
  for (const result of results) {
    const status = result.passed ? 'PASS' : `FAIL (${result.severity})`;
    const line = `[${status}] ${result.name}: ${result.detail}`;
    if (result.passed) log.info(line);
    else log.warn(line);
    if (!result.passed && result.severity === 'error') ok = false;
  }
  return ok;
}
