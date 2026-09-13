/**
 * Data-quality checks run after each day's writes. Any failed error-severity
 * check makes the run exit non-zero, which blocks publishing.
 */

import * as config from './config.ts';
import type { IsoDate } from './dates.ts';
import type { Database } from './db.ts';
import { log } from './log.ts';
import { missRate, type CoverageAudit, type SearchResult } from './search.ts';
import type { PageFetchStats, QuoteStats } from './store.ts';

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
      rate <= config.MAX_COVERAGE_MISS_RATE,
      `${coverage.missedIds.length}/${coverage.seen} listings in ${coverage.boxes} audit ` +
        `boxes were missed by the price bands (${percent(rate)}, max ` +
        `${percent(config.MAX_COVERAGE_MISS_RATE)})` +
        (coverage.missedIds.length ? `; e.g. ${coverage.missedIds.slice(0, 5).join(', ')}` : ''),
    );
  } else {
    // No usable audit boxes; report it rather than passing silently.
    check('search_coverage', 'warn', false, 'coverage audit did not run: no usable audit boxes');
  }

  const currentCount = await db.count('SELECT count(*) FROM listings WHERE is_current');
  const [lo, hi] = config.PLAUSIBLE_LISTING_COUNT;
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

  const bbox = config.BBOX;
  const outOfBbox = await db.count(
    'SELECT count(*) FROM listings WHERE is_current AND ' +
      '(location_lat IS NULL OR location_lng IS NULL OR location_lat < ? ' +
      'OR location_lat > ? OR location_lng < ? OR location_lng > ?)',
    [bbox.swLat - 0.05, bbox.neLat + 0.05, bbox.swLng - 0.05, bbox.neLng + 0.05],
  );
  check(
    'coords_within_bbox',
    'warn',
    outOfBbox === 0,
    `${outOfBbox} current listings outside the Anchorage bbox (+buffer)`,
  );

  const runs = await db.rows<{
    calendar_fetch_attempted: number | null;
    calendar_fetch_failed: number | null;
    first_review_fetch_attempted: number | null;
    first_review_fetch_failed: number | null;
  }>(
    'SELECT calendar_fetch_attempted, calendar_fetch_failed, ' +
      'first_review_fetch_attempted, first_review_fetch_failed FROM scrape_runs ' +
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
      rate <= config.MAX_CALENDAR_FAILURE_RATE,
      `${failed}/${attempted} calendar fetches failed (${percent(rate)})`,
    );
  } else {
    check('calendar_failure_rate', 'error', false, 'no scrape_runs row found for this scrape_date');
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
      rate <= config.MAX_FIRST_REVIEW_FAILURE_RATE,
      `${failed}/${reviewsAttempted} first-review fetches failed (${percent(rate)}, max ` +
        `${percent(config.MAX_FIRST_REVIEW_FAILURE_RATE)})`,
    );
  }

  const freshness = await db.count(
    'SELECT count(*) FROM listing_observations WHERE scrape_date = CAST(? AS DATE)',
    [scrapeDate],
  );
  check(
    'observations_written_today',
    'error',
    freshness > 0,
    `${freshness} listing_observations rows for ${scrapeDate}`,
  );

  // Zero attempts means no listings, which `listing_count_plausible` reports.
  const pageStats = inputs.pageStats;
  if (pageStats.attempted) {
    const rate = pageStats.failed / pageStats.attempted;
    check(
      'listing_page_failure_rate',
      'error',
      rate <= config.MAX_PAGE_FAILURE_RATE,
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

    // Read from this run's pages rather than `listing_photos`, which keeps the
    // previous set current when a page yields none and so would hide a broken
    // extraction.
    const photoShare = pageStats.withPhotos / fetched;
    check(
      'photo_coverage',
      'error',
      photoShare >= config.MIN_PAGE_FIELD_SHARE,
      `${pageStats.withPhotos}/${fetched} pages read this run had photos ` +
        `(${percent(photoShare)}, min ${percent(config.MIN_PAGE_FIELD_SHARE)})`,
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
  const minShare = config.MIN_PAGE_FIELD_SHARE;
  const pageRead = await db.count(
    'SELECT count(*) FROM listings WHERE is_current AND page_seen_date IS NOT NULL',
  );
  if (pageRead) {
    const minimums = [
      ['host_id', minShare],
      ['room_type', minShare],
      ['guest_capacity', minShare],
      ['beds', minShare],
      ['bedrooms', config.MIN_BEDROOMS_SHARE],
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
      failureRate <= config.MAX_QUOTE_FAILURE_RATE,
      `${quoteStats.failed}/${quoteStats.attempted} price quotes failed (${percent(failureRate)})`,
    );
    const read = quoteStats.attempted - quoteStats.failed;
    if (read) {
      const pricedShare = quoteStats.priced / read;
      check(
        'price_quote_priced',
        'error',
        pricedShare >= config.MIN_QUOTE_PRICE_SHARE,
        `${quoteStats.priced}/${read} price quotes read carried a price ` +
          `(${percent(pricedShare)}, min ${percent(config.MIN_QUOTE_PRICE_SHARE)})`,
      );
    }
  }

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
    'SELECT count(*) FROM calendar_status WHERE night_date < valid_from',
  );
  check(
    'no_backdated_calendar_rows',
    'error',
    backdated === 0,
    `${backdated} calendar_status rows with night_date before their own valid_from`,
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
