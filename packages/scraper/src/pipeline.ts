/**
 * The daily pipeline: search Anchorage, fetch every listing's page and
 * calendar, write the day to DuckDB, and run the quality checks.
 */

import { fetchApiKey } from './airbnb/apiKey.ts';
import { fetchCalendars, liveCalendarFetcher } from './calendars.ts';
import { report, runChecks } from './checks.ts';
import { toSqlTimestamp, todayUtc, type IsoDate } from './dates.ts';
import { fetchListingPages, livePageFetcher } from './listingPage.ts';
import { describeError, log } from './log.ts';
import { parseListing, type ParsedListing } from './parse.ts';
import { pace, resetPace } from './pace.ts';
import { auditCoverage, liveSearchFetcher, searchAnchorage } from './search.ts';
import {
  connect,
  logRun,
  mergeCalendar,
  recordObservations,
  summarizePages,
  type RunRow,
} from './store.ts';

export interface RunDailyOptions {
  dbPath: string;
  scrapeDate?: IsoDate;
}

/**
 * Run one daily scrape, write, and quality check. Resolves to true iff every
 * error-severity check passed.
 *
 * All fetches happen first, then all writes in one transaction (see
 * `Database.transaction`). Fetches are paced by `pace.ts`; a 429 throws
 * `RateLimitedError`, which aborts the run.
 *
 * The page pass always runs. Skipping it would write rows with page fields
 * carried forward from earlier days, indistinguishable from fresh reads.
 */
export async function runDaily(options: RunDailyOptions): Promise<boolean> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const startedAt = toSqlTimestamp(new Date());
  log.info(`=== anchorage-str-db daily run: ${scrapeDate} ===`);

  resetPace();

  const db = await connect(options.dbPath);
  try {
    // ---- network phase ---------------------------------------------------
    // Outside the transaction: these passes take most of an hour, and a
    // failure here writes nothing.
    await pace().waitTurn();
    const apiKey = await fetchApiKey();
    const fetchPage = liveSearchFetcher(apiKey);

    const searchResult = await searchAnchorage({ fetchPage });
    // De-dupe by listing id, keeping the last occurrence.
    const parsedById = new Map<bigint, ParsedListing>();
    for (const raw of searchResult.listings) {
      const listing = parseListing(raw);
      parsedById.set(listing.listingId, listing);
    }
    const parsed = [...parsedById.values()];
    log.info(
      `parsed ${parsed.length} distinct listings (from ${searchResult.listings.length} raw ` +
        `results across ${searchResult.queries} search queries)`,
    );

    const coverage = await auditCoverage(searchResult.listings, scrapeDate, { fetchPage });

    const roomIds = parsed.map((listing) => String(listing.listingId));

    const pages = await fetchListingPages(roomIds, { fetchOne: livePageFetcher() });
    const pageStats = summarizePages(pages);
    log.info(
      `listing pages: ${pageStats.attempted} fetched, ${pageStats.failed} failed, ` +
        `${pageStats.exactLocated} with an exact location, ${pageStats.registered} with an ` +
        'STR registration number',
    );

    const calendarResults = await fetchCalendars(roomIds, {
      minDate: scrapeDate,
      fetchOne: liveCalendarFetcher(apiKey),
    });

    // ---- write phase -----------------------------------------------------
    const stats = await db.transaction(async () => {
      const listingStats = await recordObservations(db, scrapeDate, parsed, pages);
      const calendarStats = await mergeCalendar(db, scrapeDate, calendarResults);
      await logRun(db, {
        scrapeDate,
        runStartedAt: startedAt,
        runFinishedAt: toSqlTimestamp(new Date()),
        listingsSeen: listingStats.seen,
        listingsNew: listingStats.new,
        listingsChanged: listingStats.changed,
        listingsRetired: listingStats.retired,
        calendarFetchAttempted: calendarStats.attempted,
        calendarFetchFailed: calendarStats.failed,
        calendarNightsChanged: calendarStats.nightsChanged,
        pageFetchAttempted: pageStats.attempted,
        pageFetchFailed: pageStats.failed,
        errorSummary: null,
      });
      return { pageStats, searchResult, coverage };
    });

    // After commit, so the checks see what later queries will see.
    const results = await runChecks(db, scrapeDate, stats);
    const ok = report(results);
    log.info(`=== run ${scrapeDate}: ${ok ? 'PASSED' : 'FAILED'} ===`);
    return ok;
  } catch (err) {
    log.error(`daily run failed: ${describeError(err)}`);
    // After the rollback, so this row is kept. NULL counts: nothing was
    // written.
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
    listingsSeen: null,
    listingsNew: null,
    listingsChanged: null,
    listingsRetired: null,
    calendarFetchAttempted: null,
    calendarFetchFailed: null,
    calendarNightsChanged: null,
    pageFetchAttempted: null,
    pageFetchFailed: null,
    errorSummary,
  };
}
