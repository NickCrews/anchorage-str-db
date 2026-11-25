/**
 * The license scrape: find the newest license id, choose which ids to read
 * (`chooseLicenseIds`), read their CityView pages, write the reads to
 * DuckDB, run the geocoding pass (`runGeocodePass`), and run the scrape's
 * checks.
 *
 * Like the Airbnb scrape, it makes every request before writing, then writes in
 * one transaction. The geocoding pass does the same on its own, after the
 * page reads are written: it geocodes the addresses those reads hold, and a
 * failure in it leaves them written.
 */

import { connect } from '@anchorage-str-db/db/connect';
import {
  fetchLicensePages,
  fetchNewestCityviewLicenseId,
  type FetchOneLicensePage,
  type HiddenLicensePage,
  type LicensePage,
} from '@anchorage-str-db/licenses-client/licensePage';
import { report } from '@anchorage-str-db/utils/checks';
import { toSqlTimestamp, todayUtc, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log } from '@anchorage-str-db/utils/log';

import { runChecks } from './checks.ts';
import { runGeocodePass, type GeocodePassStats, type GisClients } from './geocode.ts';
import { chooseLicenseIds } from './select.ts';
import { latestReads, logRun, recordLicenseReads, type RunRow } from './store.ts';

/**
 * Milliseconds in a scrape during which license pages are read, when the
 * caller sets none. `licenses.yml` passes its own, beside its timeout.
 */
export const LICENSE_READ_BUDGET_MS = 75 * 60_000;

export interface ScrapeLicensesOptions {
  dbPath: string;
  scrapeDate?: IsoDate;
  /** Milliseconds the page reads may start requests for; `LICENSE_READ_BUDGET_MS` when absent. */
  readBudgetMs?: number;
  /** Milliseconds the geocoding may start requests for; `GEOCODE_BUDGET_MS` when absent. */
  geocodeBudgetMs?: number;
  /** The newest license id; the License Locator by default. */
  fetchNewest?: () => Promise<number>;
  /** One page read; the live portal by default. */
  fetchOne?: FetchOneLicensePage;
  /** The Muni GIS services; the live ones by default. */
  gis?: GisClients;
}

/** Resolves to true iff every error-severity check passed. */
export async function scrapeLicenses(options: ScrapeLicensesOptions): Promise<boolean> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const startedAt = toSqlTimestamp(new Date());
  log.info(`=== anchorage-str-db license scrape: ${scrapeDate} ===`);

  const db = await connect(options.dbPath);
  try {
    // ---- network phase ---------------------------------------------------
    const newest = await (options.fetchNewest ?? fetchNewestCityviewLicenseId)();
    const ids = chooseLicenseIds({
      newestCityviewLicenseId: newest,
      latestReads: await latestReads(db),
      scrapeDate,
    });
    log.info(`newest license id ${newest}; ${ids.length} license ids in read order`);

    const results = await fetchLicensePages(ids, {
      ...(options.fetchOne ? { fetchOne: options.fetchOne } : {}),
      budgetMs: options.readBudgetMs ?? LICENSE_READ_BUDGET_MS,
    });
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
      await logRun(db, {
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

    let geocoding: GeocodePassStats | { error: string };
    try {
      geocoding = await runGeocodePass(db, scrapeDate, {
        ...options.gis,
        ...(options.geocodeBudgetMs === undefined ? {} : { budgetMs: options.geocodeBudgetMs }),
      });
    } catch (err) {
      log.error(`the geocoding pass failed: ${describeError(err)}`);
      geocoding = { error: describeError(err) };
    }

    const ok = report(await runChecks(db, scrapeDate, { pages, geocoding }));
    log.info(`=== license scrape ${scrapeDate}: ${ok ? 'PASSED' : 'FAILED'} ===`);
    return ok;
  } catch (err) {
    log.error(`license scrape failed: ${describeError(err)}`);
    // After the rollback, so this row is kept.
    await logRun(db, failedRunRow(scrapeDate, startedAt, describeError(err)));
    throw err;
  } finally {
    db.close();
  }
}

function failedRunRow(scrapeDate: IsoDate, startedAt: string, errorSummary: string): RunRow {
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
