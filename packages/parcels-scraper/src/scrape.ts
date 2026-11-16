/**
 * The parcel scrape: attach anchorage-property's published database, copy
 * its current parcels, check them, then replace `property_parcels` and log
 * the scrape in one transaction.
 *
 * Nothing here scrapes the Muni: anchorage-property reads the parcel layer
 * and keeps its history, and this repo keeps only the current state of the
 * parcels it joins licenses to.
 */

import { connect } from '@anchorage-str-db/db/connect';
import { report } from '@anchorage-str-db/utils/checks';
import { toSqlTimestamp, todayUtc, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log } from '@anchorage-str-db/utils/log';

import { runSourceChecks } from './checks.ts';
import { logRun, readSource, replaceParcels, type RunRow } from './store.ts';

/**
 * anchorage-property's current-rows file (~36 MB, refreshed daily). DuckDB
 * reads it over HTTPS with range requests, so a scrape downloads only the
 * columns it reads.
 */
export const ANCHORAGE_PROPERTY_URL =
  'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb';

export interface ScrapeParcelsOptions {
  dbPath: string;
  scrapeDate?: IsoDate;
  /** The source database, an https URL or a local path; `ANCHORAGE_PROPERTY_URL` by default. */
  sourceUrl?: string;
}

/**
 * Resolves to true iff every error-severity check passed and the table was
 * replaced. A source that fails a check leaves `property_parcels` as it was.
 */
export async function scrapeParcels(options: ScrapeParcelsOptions): Promise<boolean> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const sourceUrl = options.sourceUrl ?? ANCHORAGE_PROPERTY_URL;
  const startedAt = toSqlTimestamp(new Date());
  log.info(`=== anchorage-str-db parcel scrape: ${scrapeDate} ===`);

  const db = await connect(options.dbPath);
  try {
    // ---- read phase ------------------------------------------------------
    const readStart = Date.now();
    const source = await readSource(db, sourceUrl);
    const sourceIngestRun = source.newestIngestRun?.runId ?? null;
    log.info(
      `read ${sourceUrl} in ${((Date.now() - readStart) / 1000).toFixed(1)}s; ` +
        `newest ingest run ${sourceIngestRun ?? 'unknown'}`,
    );

    const checks = await runSourceChecks(db, scrapeDate, source);
    if (!report(checks)) {
      const failed = checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.name);
      const summary = `the source failed ${failed.join(', ')}; property_parcels was not replaced`;
      log.error(summary);
      await logRun(db, failedRunRow(scrapeDate, startedAt, sourceIngestRun, summary));
      log.info(`=== parcel scrape ${scrapeDate}: FAILED ===`);
      return false;
    }

    // ---- write phase -----------------------------------------------------
    const parcelsWritten = await db.transaction(async () => {
      const written = await replaceParcels(db, scrapeDate);
      await logRun(db, {
        scrapeDate,
        runStartedAt: startedAt,
        runFinishedAt: toSqlTimestamp(new Date()),
        parcelsWritten: written,
        sourceIngestRun,
        errorSummary: null,
      });
      return written;
    });
    log.info(`property_parcels: ${parcelsWritten} parcels`);
    log.info(`=== parcel scrape ${scrapeDate}: PASSED ===`);
    return true;
  } catch (err) {
    log.error(`parcel scrape failed: ${describeError(err)}`);
    // After the rollback, so this row is kept.
    await logRun(db, failedRunRow(scrapeDate, startedAt, null, describeError(err)));
    throw err;
  } finally {
    db.close();
  }
}

function failedRunRow(
  scrapeDate: IsoDate,
  startedAt: string,
  sourceIngestRun: string | null,
  errorSummary: string,
): RunRow {
  return {
    scrapeDate,
    runStartedAt: startedAt,
    runFinishedAt: toSqlTimestamp(new Date()),
    parcelsWritten: null,
    sourceIngestRun,
    errorSummary,
  };
}
