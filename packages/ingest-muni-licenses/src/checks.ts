/**
 * Data-quality checks run after each license scan's writes. Any failed
 * error-severity check makes the `scan` command exit non-zero, which blocks
 * publishing.
 */

import type { Database } from '@anchorage-str-db/db/database';
import type { LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import { percent, type CheckResult, type Severity } from '@anchorage-str-db/utils/checks';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import type { GeocodePassStats } from './geocode.ts';
import { SHORT_TERM_RENTALS } from './select.ts';

/** A license-page failure rate above this fails the scan. */
const MAX_LICENSE_PAGE_FAILURE_RATE = 0.25;

/**
 * The share of visible pages read with a status and an issuance below which
 * the scan fails. Every page sampled had both, so a shortfall means the page
 * layout changed under the parser.
 */
const MIN_PAGE_FIELD_SHARE = 0.95;

/**
 * A geocoding-pass failure rate above this fails `geocode_failure_rate`. A
 * warning: a failed geocode or parcel read is retried next scan, and the page
 * reads are written already.
 */
const MAX_GEOCODE_FAILURE_RATE = 0.25;

/**
 * The share of geocoded addresses with a match below which
 * `geocode_match_rate` fails. 97% of a sample of registered addresses
 * matched (2026-11-10), so a drop means the geocoder or the license pages'
 * addresses changed.
 */
const MIN_GEOCODE_MATCH_SHARE = 0.85;

export interface ScanCheckInputs {
  /** This scan's visible page reads. */
  pages: readonly LicensePage[];
  /** What the geocoding pass did, or why it failed. */
  geocoding: GeocodePassStats | { error: string };
}

export async function runScanChecks(
  db: Database,
  scrapeDate: IsoDate,
  inputs: ScanCheckInputs,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, severity: Severity, passed: boolean, detail: string): void => {
    results.push({ name, severity, passed, detail });
  };

  const run = (
    await db.rows<{
      newest_cityview_license_id: number | null;
      pages_attempted: number | null;
      pages_failed: number | null;
    }>(
      'SELECT newest_cityview_license_id, pages_attempted, pages_failed FROM muni_license_runs ' +
        'WHERE scrape_date = CAST(? AS DATE) AND pages_attempted IS NOT NULL ' +
        'ORDER BY run_started_at DESC LIMIT 1',
      [scrapeDate],
    )
  )[0];
  if (!run) {
    check('license_run_logged', 'error', false, `no completed muni_license_runs row for ${scrapeDate}`);
    return results;
  }
  check('license_run_logged', 'error', true, `muni_license_runs has a completed scan for ${scrapeDate}`);

  const attempted = run.pages_attempted ?? 0;
  if (attempted) {
    const failed = run.pages_failed ?? 0;
    const rate = failed / attempted;
    check(
      'license_page_failure_rate',
      'error',
      rate <= MAX_LICENSE_PAGE_FAILURE_RATE,
      `${failed}/${attempted} license page reads failed (${percent(rate)}, max ` +
        `${percent(MAX_LICENSE_PAGE_FAILURE_RATE)})`,
    );
  }

  const read = inputs.pages.length;
  if (read) {
    const complete = inputs.pages.filter(
      (page) => page.status !== null && page.issuances.length > 0,
    ).length;
    check(
      'license_page_fields_present',
      'error',
      complete / read >= MIN_PAGE_FIELD_SHARE,
      `${complete}/${read} license pages read had a status and an issuance ` +
        `(${percent(complete / read)}, min ${percent(MIN_PAGE_FIELD_SHARE)})`,
    );
  }

  // Airbnb listings print the registration id in this shape, so another
  // would not join to them.
  const malformed = inputs.pages.flatMap((page) =>
    page.licenseType === SHORT_TERM_RENTALS
      ? page.issuances
          .filter((i) => i.type === 'STR Certificate' && !/^STR\d{8}$/.test(i.number ?? ''))
          .map(() => page.cityviewLicenseId)
      : [],
  );
  check(
    'registration_id_format',
    'warn',
    malformed.length === 0,
    `${malformed.length} STR Certificates read today have a number that is not STR followed by 8 digits` +
      (malformed.length ? `; e.g. licenses ${malformed.slice(0, 5).join(', ')}` : ''),
  );

  // The newest license should be in the read history once the scan has
  // caught up; a failed read of it is retried next scan.
  const newest = run.newest_cityview_license_id;
  if (newest !== null) {
    const found = await db.count(
      'SELECT count(*) FROM (SELECT cityview_license_id FROM muni_license_page_reads ' +
        'UNION ALL SELECT cityview_license_id FROM muni_license_hidden_reads) WHERE cityview_license_id = ?',
      [newest],
    );
    check(
      'newest_license_read',
      'warn',
      found > 0,
      `the newest license, ${newest}, has ${found > 0 ? 'been' : 'never been'} read`,
    );
  }

  const { geocoding } = inputs;
  if ('error' in geocoding) {
    check('geocode_failure_rate', 'warn', false, `the geocoding pass failed: ${geocoding.error}`);
  } else {
    const attempted = geocoding.addressesAttempted + geocoding.parcelsAttempted;
    const failed = geocoding.addressesFailed + geocoding.parcelsFailed;
    const rate = attempted ? failed / attempted : 0;
    check(
      'geocode_failure_rate',
      'warn',
      rate <= MAX_GEOCODE_FAILURE_RATE,
      `${geocoding.addressesFailed}/${geocoding.addressesAttempted} geocodes and ` +
        `${geocoding.parcelsFailed}/${geocoding.parcelsAttempted} parcel type reads failed ` +
        `(${percent(rate)}, max ${percent(MAX_GEOCODE_FAILURE_RATE)})`,
    );
  }

  // Over every address ever geocoded, so a day of retried misses doesn't trip it.
  const [geocodes] = await db.rows<{ total: number; matched: number }>(
    'SELECT count(*)::INTEGER AS total, count(matched_address)::INTEGER AS matched FROM muni_address_geocodes',
  );
  if (geocodes?.total) {
    const share = geocodes.matched / geocodes.total;
    check(
      'geocode_match_rate',
      'warn',
      share >= MIN_GEOCODE_MATCH_SHARE,
      `${geocodes.matched}/${geocodes.total} license addresses geocoded to a match ` +
        `(${percent(share)}, min ${percent(MIN_GEOCODE_MATCH_SHARE)})`,
    );
  }

  return results;
}
