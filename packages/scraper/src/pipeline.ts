/**
 * The daily pipeline: search Anchorage, fetch every listing's page and
 * calendar and unresolved listings' earliest reviews, write the day to
 * DuckDB, and run the quality checks.
 */

import { fetchApiKey } from './airbnb/apiKey.ts';
import { fetchCalendars, liveCalendarFetcher } from './calendars.ts';
import { report, runChecks } from './checks.ts';
import { addDays, toSqlTimestamp, todayUtc, type IsoDate } from './dates.ts';
import { fetchFirstReviews, liveReviewPageFetcher } from './firstReviews.ts';
import { fetchListingPages, livePageFetcher } from './listingPage.ts';
import { describeError, log } from './log.ts';
import { parseListing, type ParsedListing } from './parse.ts';
import { fetchPriceQuotes, liveQuoteFetcher } from './priceQuotes.ts';
import { pace, resetPace } from './pace.ts';
import { auditCoverage, liveSearchFetcher, searchAnchorage } from './search.ts';
import {
  connect,
  logRun,
  mergeCalendar,
  pendingFirstReviews,
  recordFirstReviews,
  recordObservations,
  summarizeFirstReviews,
  summarizePages,
  summarizeQuotes,
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
        `STR registration number, ${pageStats.withHostId} with a host id, ` +
        `${pageStats.withRoomType} with a room type, ${pageStats.withGuestCapacity} with a ` +
        `guest capacity, ${pageStats.withBeds} with beds, ${pageStats.withBedrooms} with ` +
        `bedrooms, ${pageStats.withBathrooms} with bathrooms, ${pageStats.withPhotos} with photos`,
    );

    const calendarResults = await fetchCalendars(roomIds, {
      minDate: scrapeDate,
      fetchOne: liveCalendarFetcher(apiKey),
    });

    // Needs the calendars, to choose a stay that can be booked.
    const quotes = await fetchPriceQuotes(calendarResults, {
      firstCheckIn: addDays(scrapeDate, 1),
      fetchOne: liveQuoteFetcher(apiKey),
    });
    const quoteStats = summarizeQuotes(quotes);
    log.info(
      `price quotes: ${quoteStats.attempted} listings with a bookable stay, ` +
        `${quoteStats.failed} failed, ${quoteStats.priced} priced`,
    );

    // Capped per run by FIRST_REVIEW_MAX_PER_RUN; the rest wait for later runs.
    const pendingReviews = await pendingFirstReviews(db, parsed);
    const firstReviews = await fetchFirstReviews(pendingReviews, {
      fetchPage: liveReviewPageFetcher(apiKey),
    });
    const firstReviewStats = summarizeFirstReviews(firstReviews);
    log.info(
      `first reviews: ${firstReviewStats.attempted} of ${pendingReviews.length} unresolved ` +
        `listings fetched, ${firstReviewStats.failed} failed, ` +
        `${firstReviewStats.withReviews} with at least one review`,
    );

    // ---- write phase -----------------------------------------------------
    const stats = await db.transaction(async () => {
      const listingStats = await recordObservations(db, scrapeDate, parsed, pages, quotes);
      const calendarStats = await mergeCalendar(db, scrapeDate, calendarResults);
      await recordFirstReviews(db, scrapeDate, firstReviews);
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
        firstReviewFetchAttempted: firstReviewStats.attempted,
        firstReviewFetchFailed: firstReviewStats.failed,
        quoteFetchAttempted: quoteStats.attempted,
        quoteFetchFailed: quoteStats.failed,
        errorSummary: null,
      });
      return { pageStats, quoteStats, searchResult, coverage };
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
    firstReviewFetchAttempted: null,
    firstReviewFetchFailed: null,
    quoteFetchAttempted: null,
    quoteFetchFailed: null,
    errorSummary,
  };
}
