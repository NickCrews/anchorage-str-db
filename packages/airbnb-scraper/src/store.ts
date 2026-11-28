/**
 * Writes for the daily Airbnb run. The tables are defined in
 * `@anchorage-str-db/db/schema` and the views that read them in
 * `@anchorage-str-db/db/views`.
 */

import type { Database } from '@anchorage-str-db/db/database';
import {
  airbnbCalendarStatus,
  airbnbHostObservations,
  airbnbListingFirstReviews,
  airbnbListingObservations,
  airbnbListingPhotos,
  airbnbScrapeRuns,
} from '@anchorage-str-db/db/schema';
import { RETIREMENT_GRACE_DAYS } from '@anchorage-str-db/db/views';
import { listingUrl, type Calendar, type Listing, type ListingId, type SearchListing } from 'airbnb-dlp';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

import {
  buildingType,
  nightsFrom,
  registrationId,
  stayNights,
  type FirstReview,
  type HostCard,
  type StayQuote,
} from './airbnb.ts';

// --------------------------------------------------------------------------
// observations

export interface ObservationStats {
  seen: number;
  new: number;
  changed: number;
  retired: number;
}

/**
 * Write one day's listing observations and report what changed.
 *
 * Idempotent per scrape date: re-running a day replaces its rows.
 *
 * A listing with no entry in `pages` records `page_fetch_ok = false` and NULL
 * page columns. One with no entry in `quotes` records NULL quote columns.
 *
 * `changed` and `retired` are read from the views so the run log matches
 * what later queries see.
 */
export async function recordObservations(
  db: Database,
  scrapeDate: IsoDate,
  listings: readonly SearchListing[],
  pages: ReadonlyMap<ListingId, Listing> = new Map(),
  quotes: ReadonlyMap<ListingId, StayQuote> = new Map(),
): Promise<ObservationStats> {

  await db.run('DELETE FROM airbnb_listing_observations WHERE scrape_date = CAST(? AS DATE)', [scrapeDate]);
  // After the delete, so a re-run doesn't count its own earlier rows as
  // history. `BIGINT` reads back as a decimal string, which `BigInt` parses
  // exactly.
  const previouslySeen = new Set(
    (
      await db.rows<{ listing_id: string }>(
        'SELECT DISTINCT listing_id FROM airbnb_listing_observations',
      )
    ).map((row) => BigInt(row.listing_id)),
  );

  await db.appendRows(
    airbnbListingObservations,
    listings.map((listing) => {
      const page = pages.get(listing.id);
      const quoted = quotes.get(listing.id);
      return {
        listingId: BigInt(listing.id),
        scrapeDate,
        name: listing.name,
        locationLat: listing.location?.lat ?? null,
        locationLng: listing.location?.lng ?? null,
        url: listingUrl(listing.id),
        badges: [...listing.badges],
        ratingValue: listing.rating,
        reviewCount: listing.reviewCount,
        priceHintPerNight: listing.price?.nightly?.amount ?? listing.price?.total?.amount ?? null,
        priceNights: listing.price?.nights ?? null,
        pageFetchOk: page !== undefined,
        locationIsExact: page?.location?.exact ?? null,
        locationExactAddress: page?.address ?? null,
        locationSubtitle: page?.location?.subtitle ?? null,
        locationVerified: page?.location?.verified ?? null,
        registrationId: page ? registrationId(page.registration) : null,
        hostId: page?.host ? BigInt(page.host.id) : null,
        listingType: page?.roomType ?? null,
        guestCapacity: page?.guestCapacity ?? null,
        beds: page?.beds ?? null,
        bedrooms: page?.bedrooms?.text ?? null,
        bathrooms: page?.bathrooms?.text ?? null,
        quoteCheckIn: quoted?.stay.checkIn ?? null,
        quoteNights: quoted ? stayNights(quoted.stay) : null,
        quoteTotal: quoted?.quote?.total.amount ?? null,
        quoteBreakdown: quoted?.quote ? [...quoted.quote.breakdown] : null,
        buildingType: page ? buildingType(page) : null,
      };
    }),
  );

  await recordPhotos(
    db,
    scrapeDate,
    listings.flatMap((listing) => {
      const urls = pages.get(listing.id)?.photoUrls;
      return urls?.length ? [{ listingId: BigInt(listing.id), urls }] : [];
    }),
  );

  return {
    seen: listings.length,
    new: listings.filter((listing) => !previouslySeen.has(BigInt(listing.id))).length,
    changed: await db.count(
      'SELECT count(*) FROM listing_versions WHERE valid_from = CAST(? AS DATE)',
      [scrapeDate],
    ),
    retired: await countNewlyRetired(db, scrapeDate, RETIREMENT_GRACE_DAYS),
  };
}

/**
 * Write each listing's photo set if its photos or its cover photo differ from
 * the listing's previous set. Any other change of order writes nothing, so a
 * set keeps the order it was first stored in. A page read without photos
 * writes nothing, so the previous set stays current.
 *
 * Idempotent per scrape date: re-running a day replaces its rows.
 */
async function recordPhotos(
  db: Database,
  scrapeDate: IsoDate,
  sets: ReadonlyArray<{ listingId: bigint; urls: readonly string[] }>,
): Promise<void> {
  await db.run('DELETE FROM airbnb_listing_photos WHERE valid_from = CAST(? AS DATE)', [scrapeDate]);
  if (sets.length === 0) return;

  await db.run('CREATE OR REPLACE TEMP TABLE stg_photos AS FROM airbnb_listing_photos LIMIT 0');
  await db.appendRows(
    airbnbListingPhotos,
    sets.map((set) => ({ listingId: set.listingId, validFrom: scrapeDate, photoUrls: [...set.urls] })),
    { into: 'stg_photos' },
  );

  await db.run(
    `
    INSERT INTO airbnb_listing_photos
    SELECT s.*
    FROM stg_photos s
    LEFT JOIN (
        SELECT listing_id, photo_urls FROM airbnb_listing_photos
        WHERE valid_from < CAST(? AS DATE)
        QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY valid_from DESC) = 1
    ) prev USING (listing_id)
    WHERE prev.photo_urls[1] IS DISTINCT FROM s.photo_urls[1]
       OR list_sort(prev.photo_urls) IS DISTINCT FROM list_sort(s.photo_urls)
    `,
    [scrapeDate],
  );
  await db.run('DROP TABLE stg_photos');
}

/**
 * How many listings retired on this date: those last observed
 * exactly `grace + 1` days ago.
 *
 * Assumes daily runs. A gap shifts which run reports the retirement but not
 * whether the listing is active.
 */
export async function countNewlyRetired(
  db: Database,
  scrapeDate: IsoDate,
  graceDays: number,
): Promise<number> {
  return db.count(
    'SELECT count(*) FROM (SELECT listing_id FROM airbnb_listing_observations ' +
      'GROUP BY listing_id HAVING max(scrape_date) = CAST(? AS DATE))',
    [addDays(scrapeDate, -(graceDays + 1))],
  );
}

// --------------------------------------------------------------------------
// listing-page pass statistics

/** One run's listing-page pass, summarized for logging and the quality checks. */
export interface PageFetchStats {
  attempted: number;
  failed: number;
  exactLocated: number;
  registered: number;
  withHostId: number;
  withListingType: number;
  withGuestCapacity: number;
  withBeds: number;
  withBedrooms: number;
  withBathrooms: number;
  withPhotos: number;
  /** Pages that said whether their location is exact. */
  withExactFlag: number;
}

export function summarizePages(attempted: number, pages: ReadonlyMap<ListingId, Listing>): PageFetchStats {
  const ok = [...pages.values()];
  const count = (test: (page: Listing) => boolean) => ok.filter(test).length;
  return {
    attempted,
    failed: attempted - ok.length,
    exactLocated: count((page) => page.location?.exact === true),
    registered: count((page) => registrationId(page.registration) !== null),
    withHostId: count((page) => page.host !== null),
    withListingType: count((page) => page.roomType !== null),
    withGuestCapacity: count((page) => page.guestCapacity !== null),
    withBeds: count((page) => page.beds !== null),
    withBedrooms: count((page) => page.bedrooms !== null),
    withBathrooms: count((page) => page.bathrooms !== null),
    withPhotos: count((page) => page.photoUrls.length > 0),
    withExactFlag: count((page) => page.location !== null && page.location.exact !== null),
  };
}

// --------------------------------------------------------------------------
// price-quote pass statistics

export interface QuoteStats {
  /** Listings with a bookable stay to quote. */
  attempted: number;
  failed: number;
  /** Quotes read without error that carry a price. */
  priced: number;
}

export function summarizeQuotes(attempted: number, quotes: ReadonlyMap<ListingId, StayQuote>): QuoteStats {
  const read = [...quotes.values()];
  return {
    attempted,
    failed: attempted - read.length,
    priced: read.filter((quoted) => quoted.quote !== null).length,
  };
}

// --------------------------------------------------------------------------
// hosts

export interface HostProfileStats {
  /** Distinct hosts of a listing observed today. */
  attempted: number;
  /** Of those, how many had no card read today. */
  failed: number;
  new: number;
  changed: number;
}

/**
 * Write one day's host observations: a row for every host of a listing
 * observed today, whether or not their card was read.
 *
 * Runs after `recordObservations` for the same date, in the same transaction:
 * today's owners are read back from `listings`, so a listing whose page failed
 * today still names its owner through the carried-forward `host_id`.
 *
 * `cards` is `collectHostCards`' output, keyed by host id. Idempotent per
 * scrape date.
 */
export async function recordHostObservations(
  db: Database,
  scrapeDate: IsoDate,
  cards: ReadonlyMap<string, HostCard>,
): Promise<HostProfileStats> {
  await db.run('DELETE FROM airbnb_host_observations WHERE scrape_date = CAST(? AS DATE)', [scrapeDate]);
  const previouslySeen = new Set(
    (
      await db.rows<{ host_id: string }>('SELECT DISTINCT host_id FROM airbnb_host_observations')
    ).map((row) => row.host_id),
  );
  const owners = (
    await db.rows<{ host_id: string }>(
      'SELECT DISTINCT host_id FROM listings ' +
        'WHERE valid_to IS NULL AND last_seen_date = CAST(? AS DATE) AND host_id IS NOT NULL',
      [scrapeDate],
    )
  ).map((row) => row.host_id);
  const hostIds = [...new Set([...owners, ...cards.keys()])];

  await db.appendRows(
    airbnbHostObservations,
    hostIds.map((hostId) => {
      const card = cards.get(hostId);
      return {
        hostId: BigInt(hostId),
        scrapeDate,
        profileReadOk: card !== undefined,
        name: card?.name ?? null,
        about: card?.about ?? null,
        timeAsHostYears: card?.timeAsHostYears ?? null,
        timeAsHostMonths: card?.timeAsHostMonths ?? null,
      };
    }),
  );

  return {
    attempted: hostIds.length,
    failed: hostIds.filter((hostId) => !cards.has(hostId)).length,
    new: hostIds.filter((hostId) => !previouslySeen.has(hostId)).length,
    changed: await db.count(
      'SELECT count(*) FROM host_versions WHERE valid_from = CAST(? AS DATE)',
      [scrapeDate],
    ),
  };
}

// --------------------------------------------------------------------------
// calendar

export interface CalendarMergeStats {
  attempted: number;
  failed: number;
  nightsChanged: number;
}

/** SCD2-merge one run's calendar. See `airbnbCalendarStatus` in `@anchorage-str-db/db/schema`. */
export async function mergeCalendar(
  db: Database,
  scrapeDate: IsoDate,
  attempted: number,
  calendars: ReadonlyMap<ListingId, Calendar>,
): Promise<CalendarMergeStats> {
  const stats: CalendarMergeStats = {
    attempted,
    failed: attempted - calendars.size,
    nightsChanged: 0,
  };
  const usable = [...calendars].map(([listingId, calendar]) => ({
    listingId,
    nights: nightsFrom(calendar, scrapeDate),
  }));
  if (!usable.some((result) => result.nights.length > 0)) return stats;

  await db.run(
    'CREATE OR REPLACE TEMP TABLE stg_calendar AS ' +
      'SELECT listing_id, night_date, available, min_nights FROM airbnb_calendar_status LIMIT 0',
  );
  await db.appendRows(
    airbnbCalendarStatus,
    usable.flatMap((result) =>
      result.nights.map((night) => ({
        listingId: BigInt(result.listingId),
        nightDate: night.nightDate,
        available: night.available,
        minNights: night.minNights,
      })),
    ),
    { into: 'stg_calendar', columns: ['listingId', 'nightDate', 'available', 'minNights'] },
  );

  await db.run('ALTER TABLE stg_calendar ADD COLUMN status_hash VARCHAR');
  // The trailing '|' is part of the hash format of every stored row. Changing
  // the format would re-version every current night on the next run.
  await db.run(
    "UPDATE stg_calendar SET status_hash = md5(available::VARCHAR || '|' || " +
      "coalesce(min_nights::VARCHAR,'') || '|')",
  );

  stats.nightsChanged = await db.count(
    'SELECT count(*) FROM stg_calendar s ' +
      'LEFT JOIN airbnb_calendar_status c ' +
      '  ON c.listing_id = s.listing_id AND c.night_date = s.night_date AND c.is_current ' +
      'WHERE c.listing_id IS NULL OR c.status_hash != s.status_hash',
  );
  if (stats.nightsChanged === 0) return stats;

  await db.run(
    `
    UPDATE airbnb_calendar_status SET valid_to = CAST(? AS DATE), is_current = false
    WHERE is_current AND (listing_id, night_date) IN (
        SELECT s.listing_id, s.night_date FROM stg_calendar s
        JOIN airbnb_calendar_status c
          ON c.listing_id = s.listing_id AND c.night_date = s.night_date AND c.is_current
        WHERE c.status_hash != s.status_hash
    )
    `,
    [scrapeDate],
  );
  // Changed nights no longer have a current row, so this inserts exactly
  // the new and changed ones.
  await db.run(
    'INSERT INTO airbnb_calendar_status ' +
      'SELECT s.listing_id, s.night_date, s.available, s.min_nights, s.status_hash, ' +
      '  CAST(? AS DATE), NULL, true ' +
      'FROM stg_calendar s ' +
      'LEFT JOIN airbnb_calendar_status c ' +
      '  ON c.listing_id = s.listing_id AND c.night_date = s.night_date AND c.is_current ' +
      'WHERE c.listing_id IS NULL',
    [scrapeDate],
  );
  return stats;
}

// --------------------------------------------------------------------------
// first reviews

/**
 * This run's listings whose earliest review has not been resolved, in
 * ascending `listing_id` order (older listings first). `fetchFirstReviews`
 * resolves as many as its time budget allows.
 */
export async function pendingFirstReviews(
  db: Database,
  listings: readonly SearchListing[],
): Promise<ListingId[]> {
  const resolved = new Set(
    (
      await db.rows<{ listing_id: string }>('SELECT listing_id FROM airbnb_listing_first_reviews')
    ).map((row) => BigInt(row.listing_id)),
  );
  return listings
    .map((listing) => BigInt(listing.id))
    .filter((id) => !resolved.has(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(String);
}

/**
 * Store each resolution. Throws on a listing that is already resolved, which
 * `pendingFirstReviews` never returns.
 */
export async function recordFirstReviews(
  db: Database,
  scrapeDate: IsoDate,
  resolved: readonly FirstReview[],
): Promise<void> {
  if (resolved.length === 0) return;
  await db.appendRows(
    airbnbListingFirstReviews,
    resolved.map((result) => ({
      listingId: BigInt(result.listingId),
      firstReviewDate: result.firstReviewDate,
      resolvedDate: scrapeDate,
    })),
  );
}

// --------------------------------------------------------------------------
// run log

/** Every column, so a caller cannot leave a count out by omission. */
export type RunRow = Required<typeof airbnbScrapeRuns.$inferInsert>;

export async function logRun(db: Database, run: RunRow): Promise<void> {
  await db.orm.insert(airbnbScrapeRuns).values(run);
}
