/**
 * The registry run: snapshot the Municipal Clerk's STR registration layer,
 * read a batch of CityView license pages, write them to DuckDB, and run the
 * registry checks.
 *
 * It is a separate command from `daily` so that either source being down
 * leaves the other's day intact. Like `runDaily`, it makes every request
 * before writing, then writes in one transaction.
 */

import { connect } from '@anchorage-str-db/db/connect';
import { fetchLicensePages } from '@anchorage-str-db/muni-licenses/licensePage';
import { fetchRegistrations } from '@anchorage-str-db/scraper-muni-str/registrationLayers';
import { toSqlTimestamp, todayUtc, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log } from '@anchorage-str-db/utils/log';

import { report } from './checks.ts';
import { runRegistryChecks } from './registryChecks.ts';
import {
  logRegistryRun,
  pendingLicensePages,
  recordLicensePages,
  recordRegistrations,
  type RegistryRunRow,
} from './registryStore.ts';

/**
 * License pages read per run (see `pendingLicensePages`). The ~2500 current
 * registrations need ~360 reads a day at `LICENSE_PAGE_REFRESH_DAYS`, so a
 * backfill from empty takes about 5 runs. Reading 1000 in a run took 9
 * minutes once and 24 minutes the next, when the portal began timing out and
 * the pacer backed off to 0.5/s; this cap keeps the run well inside the CI
 * timeout either way.
 */
const LICENSE_PAGE_MAX_PER_RUN = 500;

/**
 * A current registration's license page is re-read once its latest read is
 * this old. The ArcGIS layer is republished about weekly, and a page's
 * description and parcel rarely change.
 */
const LICENSE_PAGE_REFRESH_DAYS = 7;

export interface RunRegistryOptions {
  dbPath: string;
  scrapeDate?: IsoDate;
}

/** Resolves to true iff every error-severity registry check passed. */
export async function runRegistry(options: RunRegistryOptions): Promise<boolean> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const startedAt = toSqlTimestamp(new Date());
  log.info(`=== anchorage-str-db registry run: ${scrapeDate} ===`);

  const db = await connect(options.dbPath);
  try {
    // ---- network phase ---------------------------------------------------
    const { registrations, dataEditedAt } = await fetchRegistrations();
    log.info(
      `registry layer: ${registrations.length} registrations (data edited ` +
        `${dataEditedAt ?? 'at an unknown time'})`,
    );

    const pending = await pendingLicensePages(db, scrapeDate, registrations, {
      refreshDays: LICENSE_PAGE_REFRESH_DAYS,
      max: LICENSE_PAGE_MAX_PER_RUN,
    });
    const licenseResults = await fetchLicensePages(pending);
    const pages = licenseResults.flatMap((result) => (result.page ? [result.page] : []));
    const licenseStats = { attempted: licenseResults.length, failed: licenseResults.length - pages.length };
    log.info(`license pages: ${licenseStats.attempted} fetched, ${licenseStats.failed} failed`);

    // ---- write phase -----------------------------------------------------
    await db.transaction(async () => {
      const stats = await recordRegistrations(db, scrapeDate, registrations);
      await recordLicensePages(db, scrapeDate, pages);
      await logRegistryRun(db, {
        scrapeDate,
        runStartedAt: startedAt,
        runFinishedAt: toSqlTimestamp(new Date()),
        layerDataEditedAt: dataEditedAt,
        registrationsSeen: stats.seen,
        registrationsNew: stats.new,
        registrationsLapsed: stats.lapsed,
        licensePageAttempted: licenseStats.attempted,
        licensePageFailed: licenseStats.failed,
        errorSummary: null,
      });
      log.info(
        `registrations: ${stats.new} new, ${stats.lapsed} gone since the previous run`,
      );
    });

    const ok = report(await runRegistryChecks(db, scrapeDate, { pages }));
    log.info(`=== registry run ${scrapeDate}: ${ok ? 'PASSED' : 'FAILED'} ===`);
    return ok;
  } catch (err) {
    log.error(`registry run failed: ${describeError(err)}`);
    // After the rollback, so this row is kept.
    await logRegistryRun(db, failedRunRow(scrapeDate, startedAt, describeError(err)));
    throw err;
  } finally {
    db.close();
  }
}

function failedRunRow(scrapeDate: IsoDate, startedAt: string, errorSummary: string): RegistryRunRow {
  return {
    scrapeDate,
    runStartedAt: startedAt,
    runFinishedAt: toSqlTimestamp(new Date()),
    layerDataEditedAt: null,
    registrationsSeen: null,
    registrationsNew: null,
    registrationsLapsed: null,
    licensePageAttempted: null,
    licensePageFailed: null,
    errorSummary,
  };
}
