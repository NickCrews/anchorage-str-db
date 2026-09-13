/**
 * The registry refresh: read the whole layer, merge it, run the checks.
 *
 * The same shape as the scraper's `pipeline.ts` — fetch everything, then
 * write everything in one transaction — for the same reason: DuckDB
 * autocommits each statement, and a half-applied SCD2 merge reads as a
 * registry that lost records.
 *
 * The run is small enough (a few requests, seconds) that it has no pacing,
 * no concurrency and no request budget. It is written as a separate command
 * from the daily Airbnb scrape rather than a pass inside it because the two
 * fail independently: a municipal server that is down should not withhold a
 * day of Airbnb calendars, which cannot be scraped after the fact, and a
 * blocked Airbnb scrape should not withhold the registry.
 */

import { report, runChecks } from './checks.ts';
import { serviceUrl } from './config.ts';
import { toSqlTimestamp, todayUtc, type IsoDate } from './dates.ts';
import { extractRegistry } from './extract.ts';
import { describeError, log } from './log.ts';
import { connect, logRun, mergeRegistrations, type RunRow } from './store.ts';

export interface RunRefreshOptions {
  dbPath: string;
  serviceUrl?: string;
  refreshDate?: IsoDate;
}

/** Run one refresh. Resolves to true iff every error-severity check passed. */
export async function runRefresh(options: RunRefreshOptions): Promise<boolean> {
  const refreshDate = options.refreshDate ?? todayUtc();
  const startedAt = toSqlTimestamp(new Date());
  const url = serviceUrl(options.serviceUrl);
  log.info(`=== anchorage-str-db registry refresh: ${refreshDate} ===`);
  log.info(`layer: ${url}`);

  const db = await connect(options.dbPath);
  try {
    // ---- network phase, outside the transaction -------------------------
    const extract = await extractRegistry(url);
    const lastEdit =
      extract.layer.lastEditMs === null ? null : toSqlTimestamp(new Date(extract.layer.lastEditMs));
    log.info(
      `read ${extract.records.length} records; the layer was last edited ` +
        `${lastEdit ?? 'at an unpublished time'}`,
    );
    if (extract.unmapped.length > 0) {
      log.info(`layer fields kept only in attributes: ${extract.unmapped.join(', ')}`);
    }

    // ---- write phase ----------------------------------------------------
    const merge = await db.transaction(async () => {
      const stats = await mergeRegistrations(db, refreshDate, extract.records);
      await logRun(db, {
        refreshDate,
        runStartedAt: startedAt,
        runFinishedAt: toSqlTimestamp(new Date()),
        serviceUrl: url,
        layerLastEdit: lastEdit,
        recordsSeen: stats.seen,
        recordsNew: stats.new,
        recordsChanged: stats.changed,
        recordsRemoved: stats.removed,
        unmappedFields: extract.unmapped,
        errorSummary: null,
      });
      return stats;
    });
    log.info(
      `merged: ${merge.seen} seen, ${merge.new} new, ${merge.changed} opened a new version, ` +
        `${merge.removed} no longer in the layer`,
    );

    // After commit, so the checks see what later queries will see.
    const ok = report(await runChecks(db, extract, merge));
    log.info(`=== refresh ${refreshDate}: ${ok ? 'PASSED' : 'FAILED'} ===`);
    return ok;
  } catch (err) {
    log.error(`registry refresh failed: ${describeError(err)}`);
    // After the rollback, so this row is kept. NULL counts: nothing was written.
    await logRun(db, failedRunRow(refreshDate, startedAt, url, describeError(err)));
    throw err;
  } finally {
    db.close();
  }
}

function failedRunRow(
  refreshDate: IsoDate,
  startedAt: string,
  url: string,
  errorSummary: string,
): RunRow {
  return {
    refreshDate,
    runStartedAt: startedAt,
    runFinishedAt: toSqlTimestamp(new Date()),
    serviceUrl: url,
    layerLastEdit: null,
    recordsSeen: null,
    recordsNew: null,
    recordsChanged: null,
    recordsRemoved: null,
    unmappedFields: null,
    errorSummary,
  };
}
