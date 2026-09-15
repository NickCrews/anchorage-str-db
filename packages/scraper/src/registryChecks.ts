/**
 * Data-quality checks run after each registry run's writes. Any failed
 * error-severity check makes the `registry` command exit non-zero.
 */

import type { Database } from '@anchorage-str-db/db/database';
import type { LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import { MIN_PAGE_FIELD_SHARE, type CheckResult, type Severity } from './checks.ts';

/**
 * A registry run fails if the layer holds a registration count outside this
 * range. 2549 registrations were published on 2026-09-07.
 */
const PLAUSIBLE_REGISTRATION_COUNT: readonly [number, number] = [1000, 10000];

/**
 * Warn when more than this share of the previous run's registrations are
 * missing from today's layer, which suggests a partial republish rather
 * than lapsed registrations.
 */
const MAX_REGISTRATION_DEPARTURE_SHARE = 0.1;

/** A license-page failure rate above this fails the registry run. */
const MAX_LICENSE_PAGE_FAILURE_RATE = 0.25;

/**
 * Warn when fewer than this share of the registration numbers on current
 * Airbnb listings appear in the registry. 1860 of 1879 matched on
 * 2026-09-13; the rest were issued after the layer's last publish.
 */
const MIN_AIRBNB_REGISTRATION_MATCH_SHARE = 0.8;

export interface RegistryCheckInputs {
  /** This run's successful license page reads. */
  pages: readonly LicensePage[];
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export async function runRegistryChecks(
  db: Database,
  scrapeDate: IsoDate,
  inputs: RegistryCheckInputs,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, severity: Severity, passed: boolean, detail: string): void => {
    results.push({ name, severity, passed, detail });
  };

  const run = (
    await db.rows<{
      registrations_seen: number | null;
      registrations_lapsed: number | null;
      license_page_attempted: number | null;
      license_page_failed: number | null;
    }>(
      'SELECT registrations_seen, registrations_lapsed, license_page_attempted, ' +
        'license_page_failed FROM muni_str_registry_runs WHERE scrape_date = CAST(? AS DATE) ' +
        'ORDER BY run_started_at DESC LIMIT 1',
      [scrapeDate],
    )
  )[0];
  if (!run) {
    check('registry_run_logged', 'error', false, `no muni_str_registry_runs row for ${scrapeDate}`);
    return results;
  }

  const seen = run.registrations_seen ?? 0;
  const [lo, hi] = PLAUSIBLE_REGISTRATION_COUNT;
  check(
    'registration_count_plausible',
    'error',
    lo <= seen && seen <= hi,
    `${seen} registrations in the layer, expected [${lo}, ${hi}]`,
  );

  // Airbnb's registration ids have this shape, so another one would not
  // join to listings.
  const malformed = await db.count(
    'SELECT count(*) FROM muni_str_registration_observations ' +
      "WHERE scrape_date = CAST(? AS DATE) AND NOT regexp_full_match(registration_id, 'STR\\d{8}')",
    [scrapeDate],
  );
  check(
    'registration_id_format',
    'warn',
    malformed === 0,
    `${malformed} registration ids today are not STR followed by 8 digits`,
  );

  const withoutLicense = await db.count(
    'SELECT count(*) FROM registrations WHERE is_active AND cityview_license_id IS NULL',
  );
  check(
    'registration_license_id_present',
    'warn',
    withoutLicense === 0,
    `${withoutLicense} active registrations have no cityviewLicenseId in status_url, so their ` +
      'license page is never read',
  );

  // The layer is a full republish, so a large drop is more likely a partial
  // publish than that many registrations lapsing at once. Recorded as
  // published either way.
  const previousSeen = await db.count(
    'SELECT registrations_seen FROM muni_str_registry_runs ' +
      'WHERE scrape_date < CAST(? AS DATE) AND registrations_seen IS NOT NULL ' +
      'ORDER BY scrape_date DESC, run_started_at DESC LIMIT 1',
    [scrapeDate],
  );
  const lapsed = run.registrations_lapsed ?? 0;
  if (previousSeen) {
    const share = lapsed / previousSeen;
    check(
      'registrations_lapsed_share',
      'warn',
      share <= MAX_REGISTRATION_DEPARTURE_SHARE,
      `${lapsed}/${previousSeen} of the previous run's registrations are gone ` +
        `(${percent(share)}, max ${percent(MAX_REGISTRATION_DEPARTURE_SHARE)})`,
    );
  }

  const attempted = run.license_page_attempted ?? 0;
  if (attempted) {
    const failed = run.license_page_failed ?? 0;
    const rate = failed / attempted;
    check(
      'license_page_failure_rate',
      'error',
      rate <= MAX_LICENSE_PAGE_FAILURE_RATE,
      `${failed}/${attempted} license page reads failed (${percent(rate)}, max ` +
        `${percent(MAX_LICENSE_PAGE_FAILURE_RATE)})`,
    );
  }

  // Every sampled page had a status and an issuance, so their absence means
  // the page layout changed under the parser.
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

  const cited = await db.count(
    'SELECT count(DISTINCT registration_id) FROM listings_active ' +
      'WHERE registration_id IS NOT NULL',
  );
  if (cited) {
    const matched = await db.count(
      'SELECT count(DISTINCT registration_id) FROM listings_active_with_registration ' +
        'WHERE registration_found',
    );
    const share = matched / cited;
    check(
      'airbnb_registration_match',
      'warn',
      share >= MIN_AIRBNB_REGISTRATION_MATCH_SHARE,
      `${matched}/${cited} registration ids on active Airbnb listings are in the registry ` +
        `(${percent(share)}, min ${percent(MIN_AIRBNB_REGISTRATION_MATCH_SHARE)})`,
    );
  }

  return results;
}
