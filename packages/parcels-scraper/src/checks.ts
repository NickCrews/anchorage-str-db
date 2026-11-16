/**
 * Data-quality checks on the source, run after it is read and before
 * `property_parcels` is replaced. Any failed error-severity check leaves the
 * table as it was and makes `pnpm scrape parcels` exit non-zero, which blocks
 * publishing.
 */

import type { Database } from '@anchorage-str-db/db/database';
import type { CheckResult, Severity } from '@anchorage-str-db/utils/checks';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

import { STAGED_PARCELS, SOURCE_TABLE, type SourceRead } from './store.ts';

/**
 * Fewer parcels than this fails the scrape. The Muni has about 98,500
 * (98,571 on 2026-11-13), so a shortfall means a truncated or broken source.
 */
export const MIN_PARCELS = 90_000;

/**
 * A newest ingest run that started more than this many days before the
 * scrape date fails `parcel_source_fresh`. A warning: anchorage-property
 * ingests daily, and a day-old snapshot still describes the parcels.
 */
export const MAX_SOURCE_AGE_DAYS = 3;

export async function runSourceChecks(
  db: Database,
  scrapeDate: IsoDate,
  source: SourceRead,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, severity: Severity, passed: boolean, detail: string): void => {
    results.push({ name, severity, passed, detail });
  };

  const { missingColumns } = source;
  check(
    'parcel_source_columns',
    'error',
    missingColumns.length === 0,
    missingColumns.length
      ? `the source's ${SOURCE_TABLE} lacks ${missingColumns.join(', ')}`
      : `the source's ${SOURCE_TABLE} has every column property_parcels takes`,
  );
  if (missingColumns.length) return results;

  const parcels = await db.count(`SELECT count(*) FROM ${STAGED_PARCELS}`);
  check(
    'parcel_count',
    'error',
    parcels >= MIN_PARCELS,
    `the source has ${parcels} parcels (min ${MIN_PARCELS})`,
  );

  // parcel_id keys property_parcels and every join to it.
  const [ids] = await db.rows<{ missing: number; duplicated: number; examples: string[] }>(
    'SELECT coalesce(sum(n) FILTER (WHERE parcel_id IS NULL), 0)::INTEGER AS missing, ' +
      'count(*) FILTER (WHERE parcel_id IS NOT NULL AND n > 1)::INTEGER AS duplicated, ' +
      'coalesce(list(parcel_id ORDER BY parcel_id) FILTER (WHERE parcel_id IS NOT NULL AND n > 1)[1:5], []) AS examples ' +
      `FROM (SELECT parcel_id, count(*) AS n FROM ${STAGED_PARCELS} GROUP BY parcel_id)`,
  );
  const missing = ids?.missing ?? 0;
  const duplicated = ids?.duplicated ?? 0;
  check(
    'parcel_id_unique',
    'error',
    missing === 0 && duplicated === 0,
    `${duplicated} duplicated parcel ids, ${missing} rows without one` +
      (duplicated ? `; e.g. ${ids?.examples.join(', ')}` : ''),
  );

  const run = source.newestIngestRun;
  const oldest = `${addDays(scrapeDate, -MAX_SOURCE_AGE_DAYS)} 00:00:00`;
  check(
    'parcel_source_fresh',
    'warn',
    run !== null && run.startedAt >= oldest,
    run === null
      ? 'the source records no successful ingest run'
      : `the source's newest ingest run, ${run.runId}, started ${run.startedAt} UTC ` +
          `(max ${MAX_SOURCE_AGE_DAYS} days before ${scrapeDate})`,
  );

  return results;
}
