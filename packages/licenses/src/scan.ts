/**
 * The license scan: find the newest license id, choose which ids to read
 * (`chooseLicenseIds`), read their CityView pages, write the reads to
 * DuckDB, and run the scan's checks.
 *
 * Like the daily run, it makes every request before writing, then writes in
 * one transaction.
 */

import { connect } from '@anchorage-str-db/db/connect';
import {
  fetchLicensePages,
  fetchNewestCityviewLicenseId,
  type FetchOneLicensePage,
  type HiddenLicensePage,
  type LicensePage,
} from '@anchorage-str-db/muni-licenses/licensePage';
import { report } from '@anchorage-str-db/utils/checks';
import { toSqlTimestamp, todayUtc, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log } from '@anchorage-str-db/utils/log';

import { runScanChecks } from './checks.ts';
import { chooseLicenseIds, MAX_READS_PER_SCAN } from './select.ts';
import { latestReads, logLicenseRun, recordLicenseReads, type LicenseRunRow } from './store.ts';

export interface RunScanOptions {
  dbPath: string;
  scrapeDate?: IsoDate;
  /** Reads per scan; `MAX_READS_PER_SCAN` by default. */
  maxReads?: number;
  /** The newest license id; the License Locator by default. */
  fetchNewest?: () => Promise<number>;
  /** One page read; the live portal by default. */
  fetchOne?: FetchOneLicensePage;
}

/** Resolves to true iff every error-severity check passed. */
export async function runScan(options: RunScanOptions): Promise<boolean> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const startedAt = toSqlTimestamp(new Date());
  log.info(`=== anchorage-str-db license scan: ${scrapeDate} ===`);

  const db = await connect(options.dbPath);
  try {
    // ---- network phase ---------------------------------------------------
    const newest = await (options.fetchNewest ?? fetchNewestCityviewLicenseId)();
    const ids = chooseLicenseIds({
      newestCityviewLicenseId: newest,
      latestReads: await latestReads(db),
      scrapeDate,
      max: options.maxReads ?? MAX_READS_PER_SCAN,
    });
    log.info(`newest license id ${newest}; reading ${ids.length} license pages`);

    const results = await fetchLicensePages(ids, options.fetchOne ? { fetchOne: options.fetchOne } : {});
    const pages: LicensePage[] = [];
    const hidden: HiddenLicensePage[] = [];
    for (const { page } of results) {
      if (page?.hidden) hidden.push(page);
      else if (page) pages.push(page);
    }
    const failed = results.length - pages.length - hidden.length;
    log.info(`license pages: ${pages.length} visible, ${hidden.length} hidden, ${failed} failed`);

    // ---- write phase -----------------------------------------------------
    await db.transaction(async () => {
      const stats = await recordLicenseReads(db, scrapeDate, pages, hidden);
      await logLicenseRun(db, {
        scrapeDate,
        runStartedAt: startedAt,
        runFinishedAt: toSqlTimestamp(new Date()),
        newestCityviewLicenseId: newest,
        pagesAttempted: results.length,
        pagesRead: pages.length,
        hiddenRead: hidden.length,
        pagesFailed: failed,
        licensesNew: stats.licensesNew,
        licensesStatusChanged: stats.licensesStatusChanged,
        errorSummary: null,
      });
      log.info(`licenses: ${stats.licensesNew} new, ${stats.licensesStatusChanged} with a changed status`);
    });

    const ok = report(await runScanChecks(db, scrapeDate, { pages }));
    log.info(`=== license scan ${scrapeDate}: ${ok ? 'PASSED' : 'FAILED'} ===`);
    return ok;
  } catch (err) {
    log.error(`license scan failed: ${describeError(err)}`);
    // After the rollback, so this row is kept.
    await logLicenseRun(db, failedRunRow(scrapeDate, startedAt, describeError(err)));
    throw err;
  } finally {
    db.close();
  }
}

function failedRunRow(scrapeDate: IsoDate, startedAt: string, errorSummary: string): LicenseRunRow {
  return {
    scrapeDate,
    runStartedAt: startedAt,
    runFinishedAt: toSqlTimestamp(new Date()),
    newestCityviewLicenseId: null,
    pagesAttempted: null,
    pagesRead: null,
    hiddenRead: null,
    pagesFailed: null,
    licensesNew: null,
    licensesStatusChanged: null,
    errorSummary,
  };
}
