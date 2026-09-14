/**
 * Data-quality checks run after each registry run's writes. Any failed
 * error-severity check makes the `registry` command exit non-zero.
 */

import type { Database } from '@anchorage-str-db/db/database';
import type { LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import type { CheckResult, Severity } from './checks.ts';
import * as config from './config.ts';

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
      registrations_departed: number | null;
      license_page_attempted: number | null;
      license_page_failed: number | null;
    }>(
      'SELECT registrations_seen, registrations_departed, license_page_attempted, ' +
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
  const [lo, hi] = config.PLAUSIBLE_REGISTRATION_COUNT;
  check(
    'registration_count_plausible',
    'error',
    lo <= seen && seen <= hi,
    `${seen} registrations in the layer, expected [${lo}, ${hi}]`,
  );

  // Airbnb's registration numbers have this shape, so another one would not
  // join to listings.
  const malformed = await db.count(
    'SELECT count(*) FROM muni_str_registration_observations ' +
      "WHERE scrape_date = CAST(? AS DATE) AND NOT regexp_full_match(registration_number, 'STR\\d{8}')",
    [scrapeDate],
  );
  check(
    'registration_number_format',
    'warn',
    malformed === 0,
    `${malformed} registration numbers today are not STR followed by 8 digits`,
  );

  const withoutLicense = await db.count(
    'SELECT count(*) FROM registrations WHERE is_current AND license_id IS NULL',
  );
  check(
    'registration_license_id_present',
    'warn',
    withoutLicense === 0,
    `${withoutLicense} current registrations have no licenseId in status_url, so their ` +
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
  const departed = run.registrations_departed ?? 0;
  if (previousSeen) {
    const share = departed / previousSeen;
    check(
      'registrations_departed_share',
      'warn',
      share <= config.MAX_REGISTRATION_DEPARTURE_SHARE,
      `${departed}/${previousSeen} of the previous run's registrations are gone ` +
        `(${percent(share)}, max ${percent(config.MAX_REGISTRATION_DEPARTURE_SHARE)})`,
    );
  }

  const attempted = run.license_page_attempted ?? 0;
  if (attempted) {
    const failed = run.license_page_failed ?? 0;
    const rate = failed / attempted;
    check(
      'license_page_failure_rate',
      'error',
      rate <= config.MAX_LICENSE_PAGE_FAILURE_RATE,
      `${failed}/${attempted} license page reads failed (${percent(rate)}, max ` +
        `${percent(config.MAX_LICENSE_PAGE_FAILURE_RATE)})`,
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
      complete / read >= config.MIN_PAGE_FIELD_SHARE,
      `${complete}/${read} license pages read had a status and an issuance ` +
        `(${percent(complete / read)}, min ${percent(config.MIN_PAGE_FIELD_SHARE)})`,
    );
  }

  const cited = await db.count(
    'SELECT count(DISTINCT str_registration_id) FROM listings_current ' +
      'WHERE str_registration_id IS NOT NULL',
  );
  if (cited) {
    const matched = await db.count(
      'SELECT count(DISTINCT str_registration_id) FROM listings_current_with_registration ' +
        'WHERE registration_found',
    );
    const share = matched / cited;
    check(
      'airbnb_registration_match',
      'warn',
      share >= config.MIN_AIRBNB_REGISTRATION_MATCH_SHARE,
      `${matched}/${cited} registration numbers on current Airbnb listings are in the registry ` +
        `(${percent(share)}, min ${percent(config.MIN_AIRBNB_REGISTRATION_MATCH_SHARE)})`,
    );
  }

  return results;
}
