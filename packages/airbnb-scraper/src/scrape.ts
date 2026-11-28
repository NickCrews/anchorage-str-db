/**
 * The Airbnb scrape: search Anchorage, keep the listings inside the
 * Municipality, fetch every listing's page and calendar and unresolved
 * listings' earliest reviews, write the day to DuckDB, and run the quality
 * checks.
 */

import { createClient, type BBox, type Client } from 'airbnb-dlp';
import { connect } from '@anchorage-str-db/db/connect';
import { report, type CheckResult } from '@anchorage-str-db/utils/checks';
import { addDays, toSqlTimestamp, todayUtc, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log } from '@anchorage-str-db/utils/log';

import {
  collectHostCards,
  fetchCalendars,
  fetchFirstReviews,
  fetchListingPages,
  fetchPriceQuotes,
  searchMunicipality,
} from './airbnb.ts';
import { runChecks } from './checks.ts';
import {
  logRun,
  mergeCalendar,
  pendingFirstReviews,
  recordFirstReviews,
  recordHostObservations,
  recordObservations,
  summarizePages,
  summarizeQuotes,
  type RunRow,
} from './store.ts';

/**
 * The live client's ceiling on requests per second, shared by every pass.
 * Airbnb allows about 130 requests per IP in a rolling minute (see
 * docs/research/airbnb/rate-limits.md). Past that, from GitHub's runners, it
 * answers every API request with HTTP 401, which airbnb-dlp counts as a
 * per-listing failure rather than a rate limit, so the client never slows
 * down by itself. 1.8/s stays under the limit; a full run, about 7,000 requests plus the
 * first-review budget, takes 65-80 minutes, within airbnb.yml's timeout.
 */
export const REQUESTS_PER_SECOND = 1.8;

export interface ScrapeAirbnbOptions {
  dbPath: string;
  scrapeDate?: IsoDate;
  /** Default: airbnb-dlp's live client. */
  client?: Client;
  /** Default: the Municipality's bounding box. */
  searchBox?: BBox;
}

/**
 * Run one Airbnb scrape, write, and quality check. Resolves to true iff every
 * error-severity check passed.
 */
export async function scrapeAirbnb(options: ScrapeAirbnbOptions): Promise<boolean> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const ok = report(await scrapeAndCheck({ ...options, scrapeDate }));
  log.info(`=== run ${scrapeDate}: ${ok ? 'PASSED' : 'FAILED'} ===`);
  return ok;
}

/**
 * Run one Airbnb scrape and write it, then resolve to the quality checks'
 * results.
 *
 * All fetches happen first, then all writes in one transaction (see
 * `Database.transaction` in `@anchorage-str-db/db`). One airbnb-dlp client
 * paces every request; if Airbnb blocks it, the run aborts.
 *
 * The page pass always runs. Skipping it would write rows with page fields
 * carried forward from earlier days, indistinguishable from fresh reads.
 */
export async function scrapeAndCheck(options: ScrapeAirbnbOptions): Promise<CheckResult[]> {
  const scrapeDate = options.scrapeDate ?? todayUtc();
  const startedAt = toSqlTimestamp(new Date());
  log.info(`=== anchorage-str-db Airbnb scrape: ${scrapeDate} ===`);

  const client = options.client ?? createClient({ limits: { requestsPerSecond: REQUESTS_PER_SECOND } });
  const db = await connect(options.dbPath);
  try {
    // ---- network phase ---------------------------------------------------
    // Outside the transaction: these passes take most of an hour, and a
    // failure here writes nothing.
    const search = await searchMunicipality(client, options.searchBox);
    log.info(
      `search: ${search.found} distinct listings in ${search.requests} requests, dropped ` +
        `${search.found - search.listings.length} outside the Municipality`,
    );
    const listingIds = search.listings.map((listing) => listing.id);

    const pagePass = await fetchListingPages(client, listingIds);
    const pageStats = summarizePages(pagePass.attempted, pagePass.pages);
    log.info(
      `listing pages: ${pageStats.attempted} fetched, ${pageStats.failed} failed, ` +
        `${pageStats.exactLocated} with an exact location, ${pageStats.registered} with an ` +
        `STR registration id, ${pageStats.withHostId} with a host id, ` +
        `${pageStats.withListingType} with a listing type, ${pageStats.withGuestCapacity} with a ` +
        `guest capacity, ${pageStats.withBeds} with beds, ${pageStats.withBedrooms} with ` +
        `bedrooms, ${pageStats.withBathrooms} with bathrooms, ${pageStats.withPhotos} with photos`,
    );

    // Every listing page carries its owner's card, so this collapses the
    // cards already fetched to one per distinct host.
    const hostCards = collectHostCards(pagePass.pages);
    log.info(`host profiles: ${hostCards.size} distinct hosts read from ${pagePass.pages.size} listing pages`);

    const calendarPass = await fetchCalendars(client, listingIds);

    // Needs the calendars, to choose a stay that can be booked.
    const quotePass = await fetchPriceQuotes(client, calendarPass.calendars, addDays(scrapeDate, 1));
    const quoteStats = summarizeQuotes(quotePass.attempted, quotePass.quotes);
    log.info(
      `price quotes: ${quoteStats.attempted} listings with a bookable stay, ` +
        `${quoteStats.failed} failed, ${quoteStats.priced} priced`,
    );

    const pendingReviews = await pendingFirstReviews(db, search.listings);
    const firstReviews = await fetchFirstReviews(client, pendingReviews);
    log.info(
      `first reviews: ${firstReviews.attempted} of ${pendingReviews.length} unresolved ` +
        `listings fetched, ${firstReviews.failed} failed, ` +
        `${firstReviews.resolved.filter((r) => r.firstReviewDate !== null).length} with at least one review`,
    );

    // ---- write phase -----------------------------------------------------
    const stats = await db.transaction(async () => {
      const listingStats = await recordObservations(
        db,
        scrapeDate,
        search.listings,
        pagePass.pages,
        quotePass.quotes,
      );
      // After the listings: it reads today's owners back from them.
      const hostStats = await recordHostObservations(db, scrapeDate, hostCards);
      const calendarStats = await mergeCalendar(
        db,
        scrapeDate,
        calendarPass.attempted,
        calendarPass.calendars,
      );
      await recordFirstReviews(db, scrapeDate, firstReviews.resolved);
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
        firstReviewFetchAttempted: firstReviews.attempted,
        firstReviewFetchFailed: firstReviews.failed,
        quoteFetchAttempted: quoteStats.attempted,
        quoteFetchFailed: quoteStats.failed,
        hostProfileAttempted: hostStats.attempted,
        hostProfileFailed: hostStats.failed,
        errorSummary: null,
      });
      return { pageStats, quoteStats, searchIncomplete: search.incomplete };
    });

    // After commit, so the checks see what later queries will see.
    return await runChecks(db, scrapeDate, stats);
  } catch (err) {
    log.error(`Airbnb scrape failed: ${describeError(err)}`);
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
    hostProfileAttempted: null,
    hostProfileFailed: null,
    errorSummary,
  };
}
