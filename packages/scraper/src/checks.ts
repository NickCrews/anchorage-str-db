/**
 * Data-quality gate. Mirrors the anchorage-property project's audit: a list
 * of checks, each error- or warn-severity, that runs after ingest and exits
 * non-zero on any error so a bad scrape never gets published quietly.
 */

import * as config from './config.ts';
import type { IsoDate } from './dates.ts';
import type { Database } from './db.ts';
import { log } from './log.ts';
import { missRate, type CoverageAudit, type SearchResult } from './search.ts';
import type { PageFetchStats } from './store.ts';

export type Severity = 'error' | 'warn';

export interface CheckResult {
  name: string;
  severity: Severity;
  passed: boolean;
  detail: string;
}

export interface CheckInputs {
  /**
   * This run's listing-page, search and coverage-audit passes. None of their
   * provenance is persisted, so their health checks read the run's in-memory
   * stats rather than the database.
   */
  pageStats: PageFetchStats;
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

  // Both of Airbnb's search defects — the silent 280-item cap and the
  // re-ranking that drops listings between pages — live in pagination, so
  // the search narrows every band until it fits one page. A band that could
  // not be narrowed that far was answered by a query that is both
  // truncatable and unstable, and nothing in the resulting data would show
  // it.
  const unresolved = inputs.searchResult.unresolved;
  check(
    'search_single_page',
    'error',
    unresolved.length === 0,
    `${unresolved.length} price bands still needed more than one page at the narrowest ` +
      'width price can express' +
      (unresolved.length ? `: ${unresolved.slice(0, 5).map(String).join(', ')}` : ''),
  );

  // `search_single_page` proves each query told the truth about its own
  // result set; it says nothing about whether the price bands, between them,
  // covered the market. A listing with no price Airbnb will filter on would
  // fall in no band and be missing from a result that looks perfectly
  // healthy. This is the check that can see that, because it asks in a shape
  // with no price filter at all.
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
    // Every audit box needed more than one page, or the search returned
    // nothing to centre one on. Either way the audit did not run, and saying
    // nothing would read as a pass.
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

  // `listings` is a view, so both this and the overlap check below are
  // structurally impossible rather than merely unlikely — they are cheap
  // assertions on the view's SQL, which is where the SCD2 logic lives and
  // therefore where it can break.
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
  }>(
    'SELECT calendar_fetch_attempted, calendar_fetch_failed FROM scrape_runs ' +
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

  // Every run makes the listing-page pass, so this gate is always live.
  // `attempted` is still checked because a run that found no listings at all
  // has already failed `listing_count_plausible` above, and dividing by zero
  // here would bury that under a stack trace.
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
    // `isExactLocation` is the whole point of the listing-page pass, and it
    // comes from the one layer that reads Airbnb's private JSON. If a run
    // reads pages but none of them yield the flag, that layer has broken and
    // the parse is degrading silently to the coordinate-only fallback.
    check(
      'exact_location_flag_present',
      'error',
      pageStats.withExactFlag > 0,
      `${pageStats.withExactFlag}/${fetched} pages read this run carried isExactLocation`,
    );

    // Which extraction layers are still working. `state` is the only one
    // that can produce the flag, so losing it is the failure above; losing
    // `json-ld` is a quieter warning that the standards-based cross-check on
    // the coordinate is gone. See listingPage.ts.
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

  // Cross-check the flag against an independent signal: Airbnb emits an
  // exact coordinate rounded to 4 decimal places and a jittered one at 5+
  // (41/41 when measured — see docs/research/airbnb-pdp-location-payload.md).
  // That's an undocumented artifact, so a mismatch doesn't mean the flag is
  // wrong — it means one of the two stopped meaning what it did, which is
  // worth a look either way.
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

  // A row's night_date should never be earlier than the scrape_date
  // (valid_from) that first observed it — if it is, that's the
  // elapsed-current-month artifact described in calendars.ts, not a real
  // calendar entry. Catches a regression of that fix, or any other bug
  // producing backdated rows.
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
