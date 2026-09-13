/**
 * Data-quality checks run after each refresh's writes. Any failed
 * error-severity check makes the run exit non-zero.
 *
 * The same severity rule as the scraper's `checks.ts`: error for "this run's
 * data is wrong or unusable", warn for "worth knowing, and the data is still
 * worth keeping". A layer that changed shape fails; a match rate that fell is
 * a finding about the world, not a bug, so it warns.
 */

import * as config from './config.ts';
import type { Database } from './db.ts';
import type { Extract } from './extract.ts';
import { CANONICAL_FIELDS } from './fields.ts';
import { log } from './log.ts';
import { duplicateRegistrationIds } from './records.ts';
import type { MergeStats } from './store.ts';

export type Severity = 'error' | 'warn';

export interface CheckResult {
  name: string;
  severity: Severity;
  passed: boolean;
  detail: string;
}

/**
 * Columns whose loss fails the run. `registrationId` is the join key this
 * package exists to provide; without `status` there is no way to tell a live
 * registration from a lapsed one. Every other column is a bonus, and its
 * absence only warns — it may simply not be in the layer.
 */
const REQUIRED_FIELDS = ['registrationId', 'status'] as const;

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export async function runChecks(
  db: Database,
  extract: Extract,
  merge: MergeStats,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, severity: Severity, passed: boolean, detail: string): void => {
    results.push({ name, severity, passed, detail });
  };

  // The extract is all-or-nothing, so this can only fail if a batch returned
  // rows for object ids nobody asked for.
  check(
    'extract_complete',
    'error',
    extract.records.length === extract.expected,
    `${extract.records.length} records read of ${extract.expected} object ids listed`,
  );

  const [lo, hi] = config.PLAUSIBLE_RECORD_COUNT;
  check(
    'record_count_plausible',
    'error',
    lo <= merge.seen && merge.seen <= hi,
    `${merge.seen} records, expected [${lo}, ${hi}]`,
  );

  const missing = REQUIRED_FIELDS.filter((field) => extract.fieldMap[field] === null);
  check(
    'required_fields_mapped',
    'error',
    missing.length === 0,
    missing.length === 0
      ? `all of ${REQUIRED_FIELDS.join(', ')} mapped to a layer field`
      : `no layer field matched ${missing.join(', ')}; add the layer's name to FIELD_ALIASES ` +
          `in fields.ts (the layer has: ${extract.layer.fields.map((f) => f.name).join(', ')})`,
  );

  const unmappedColumns = CANONICAL_FIELDS.filter((field) => extract.fieldMap[field] === null);
  check(
    'optional_fields_mapped',
    'warn',
    unmappedColumns.length === missing.length,
    unmappedColumns.length === 0
      ? 'every column mapped to a layer field'
      : `no layer field matched ${unmappedColumns.join(', ')}`,
  );

  // Layer columns nothing claimed. They are stored in `attributes`, so this
  // costs no data, but a column worth a name of its own should get one.
  check(
    'no_unmapped_layer_fields',
    'warn',
    extract.unmapped.length === 0,
    extract.unmapped.length === 0
      ? 'every layer field mapped to a column'
      : `${extract.unmapped.length} layer fields are only in attributes: ` +
          extract.unmapped.slice(0, 10).join(', '),
  );

  const withId = extract.records.filter((record) => record.registrationId !== null).length;
  const idShare = extract.records.length === 0 ? 0 : withId / extract.records.length;
  check(
    'registration_id_share',
    'error',
    idShare >= config.MIN_REGISTRATION_ID_SHARE,
    `${withId}/${extract.records.length} records have a usable registration number ` +
      `(${percent(idShare)}, min ${percent(config.MIN_REGISTRATION_ID_SHARE)})`,
  );

  // One number on several rows is legitimate (a registration covering two
  // units) but it weakens the join key, so it is worth watching.
  const duplicates = duplicateRegistrationIds(extract.records);
  check(
    'unique_registration_ids',
    'warn',
    duplicates.length === 0,
    `${duplicates.length} registration numbers appear on more than one record` +
      (duplicates.length ? `: e.g. ${duplicates.slice(0, 5).join(', ')}` : ''),
  );

  // A republish that rewrote a hashed column would show up as most of the
  // registry changing at once, which is a storage problem, not news. Growth
  // is exempt: on the first run every record is both new and changed.
  const churn = merge.seen === 0 ? 0 : merge.changed / merge.seen;
  check(
    'change_rate_plausible',
    'warn',
    merge.changed === merge.new || churn <= config.MAX_CHANGE_RATE,
    `${merge.changed}/${merge.seen} records changed this run (${percent(churn)}, over ` +
      `${percent(config.MAX_CHANGE_RATE)} is suspicious), ${merge.new} new, ` +
      `${merge.removed} removed`,
  );

  // These two test the SCD2 logic in `mergeRegistrations`.
  const multipleCurrent = await db.count(
    'SELECT count(*) FROM (SELECT record_key FROM str_registration_versions ' +
      'WHERE is_current GROUP BY record_key HAVING count(*) > 1)',
  );
  check(
    'one_current_version_per_record',
    'error',
    multipleCurrent === 0,
    `${multipleCurrent} record_keys with >1 current row`,
  );

  const overlap = await db.count(`
    SELECT count(*) FROM str_registration_versions a JOIN str_registration_versions b
      ON a.record_key = b.record_key AND a.valid_from < b.valid_from
    WHERE a.valid_to IS NULL OR a.valid_to > b.valid_from
  `);
  check(
    'no_overlapping_versions',
    'error',
    overlap === 0,
    `${overlap} overlapping SCD2 intervals`,
  );

  const withCoordinate = extract.records.filter((record) => record.locationLat !== null).length;
  check(
    'geometry_present',
    'warn',
    extract.layer.geometryType === null || withCoordinate === extract.records.length,
    extract.layer.geometryType === null
      ? 'the layer is a table with no geometry'
      : `${withCoordinate}/${extract.records.length} records have a point coordinate`,
  );

  results.push(...(await joinChecks(db)));
  return results;
}

/**
 * How well the two sides meet, when both are in this database.
 *
 * Warn-severity throughout: a low match rate is the finding, not a fault.
 * It is measured every run so the trend is in the history — Anchorage's
 * requirement that a listing show its number took effect on 2026-07-31, and
 * how quickly hosts complied is exactly what these numbers record.
 */
async function joinChecks(db: Database): Promise<CheckResult[]> {
  const exists = await db.count(
    "SELECT count(*) FROM duckdb_views() WHERE view_name = 'listing_registration_matches'",
  );
  if (!exists) return [];

  const row = await db.rows<{
    listings: number;
    listings_with_number: number;
    listings_matched: number;
    registrations: number;
    registrations_matched: number;
  }>(`
    SELECT
        count(DISTINCT listing_id) AS listings,
        count(DISTINCT listing_id) FILTER (WHERE listing_registration_key IS NOT NULL)
            AS listings_with_number,
        count(DISTINCT listing_id) FILTER (WHERE match_kind = 'matched') AS listings_matched,
        count(DISTINCT record_key) AS registrations,
        count(DISTINCT record_key) FILTER (WHERE match_kind = 'matched') AS registrations_matched
    FROM listing_registration_matches
  `);
  const counts = row[0];
  if (!counts) return [];

  const share = (part: number, whole: number): string =>
    whole === 0 ? 'n/a' : percent(Number(part) / Number(whole));

  return [
    {
      name: 'listing_registration_coverage',
      severity: 'warn',
      passed: Number(counts.listings_matched) > 0,
      detail:
        `${counts.listings_with_number}/${counts.listings} current listings show a ` +
        `registration number (${share(counts.listings_with_number, counts.listings)}); ` +
        `${counts.listings_matched} of those match a current registration ` +
        `(${share(counts.listings_matched, counts.listings_with_number)} of numbered listings)`,
    },
    {
      name: 'registry_listing_coverage',
      severity: 'warn',
      passed: Number(counts.registrations_matched) > 0,
      detail:
        `${counts.registrations_matched}/${counts.registrations} current registrations match ` +
        `an Airbnb listing (${share(counts.registrations_matched, counts.registrations)}); the ` +
        'rest are on other platforms, booked direct, or not found by the search',
    },
  ];
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
