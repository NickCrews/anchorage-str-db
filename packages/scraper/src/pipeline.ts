/**
 * The daily verb: search Anchorage, fetch every listing's calendar and its
 * own page, merge all three into the DuckDB store, log the run. One
 * function, `runDaily`, is the entire pipeline — and there is exactly one
 * way to invoke it, so the CLI, the tests, and GitHub Actions all produce
 * the same run.
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
 * Run one full daily scrape + merge + quality gate. Resolves to true iff it
 * passed.
 *
 * Two phases, in this order and not interleaved: fetch everything, then
 * write everything in one transaction. See `Database.transaction` for why
 * the writes are all-or-nothing, and the comments below for why the fetches
 * stay outside.
 *
 * Every request in the network phase is paced by one run-wide budget
 * (`pace.ts`), calibrated in `config.REQUESTS_PER_SECOND` against a measured
 * per-IP limit of roughly 130 requests per rolling minute. If Airbnb returns
 * 429 anyway, `RateLimitedError` propagates out of whichever pass hit it and
 * aborts the run through the handler below — deliberately, and without
 * retrying: the block is IP-wide and lasts on the order of an hour, so
 * continuing would write a day of failed fetches while still knocking on a
 * door that is being held shut.
 *
 * The fetching is three passes — the search, then each listing's own page,
 * then each listing's calendar. The search is itself many queries, plus a
 * short coverage audit: see `searchAnchorage` for why Anchorage cannot be
 * covered by a single query, and `auditCoverage` for how the run checks that
 * claim instead of assuming it. The page pass is not optional. It adds a
 * request per listing, but a run that skipped it would write rows whose
 * `location_is_exact` and `str_registration_id` are carried-forward stale
 * values rather than today's — a second, quieter kind of daily record that
 * nothing downstream can distinguish from the real one. `page_fetch_ok`
 * makes a skipped or failed page visible in the row itself, but a run that
 * skipped the pass wholesale would still leave a day of them.
 */
export async function runDaily(options: RunDailyOptions): Promise<boolean> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const startedAt = toSqlTimestamp(new Date());
  log.info(`=== anchorage-str-db daily run: ${scrapeDate} ===`);

  // One request budget for the whole run. Airbnb counts the search, the page
  // pass and the calendar pass against a single per-IP total, so pacing them
  // separately would be budgeting against a limit that does not exist.
  resetPace();

  const db = await connect(options.dbPath);
  try {
    // ---- network phase ---------------------------------------------------
    // Every fetch happens before any write. The passes are paced and take
    // minutes each, and they're where rate-limiting and blocking show up;
    // keeping them outside the transaction means a failure there costs zero
    // writes instead of leaving a half-written day behind.
    //
    // The API key is fetched once here and threaded through every request in
    // the run — see `airbnb/apiKey.ts`.
    await pace().waitTurn();
    const apiKey = await fetchApiKey();
    const fetchPage = liveSearchFetcher(apiKey);

    const searchResult = await searchAnchorage({ fetchPage });
    // De-dupe: bands abut at their boundary, so a listing priced exactly on
    // one can legitimately arrive twice. Keep the last occurrence.
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

    // Straight after the search, while its results are the thing being
    // judged: does a differently-shaped query find listings the price bands
    // did not? See `auditCoverage`.
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
    // Pages are recorded on the same row as the search fields they describe,
    // so a day is one row per listing and `listings` derives its versions
    // from that. Retirement needs no write at all — it is a predicate on the
    // observations, evaluated by the view.
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

    // Reads committed data: the transaction closed above, so the gate judges
    // exactly what a later query would see.
    const results = await runChecks(db, scrapeDate, stats);
    const ok = report(results);
    log.info(`=== run ${scrapeDate}: ${ok ? 'PASSED' : 'FAILED'} ===`);
    return ok;
  } catch (err) {
    log.error(`daily run failed: ${describeError(err)}`);
    // Outside the transaction, which has already rolled back — otherwise the
    // record of the failure would roll back with the run it records. The
    // all-NULL counts are literally true: nothing was written.
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
