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
import type { CalendarResult } from '@anchorage-str-db/scraper-airbnb/calendars';
import type { FirstReviewCandidate, FirstReviewResult } from '@anchorage-str-db/scraper-airbnb/firstReviews';
import type { HostCard, Layer, ListingPage } from '@anchorage-str-db/scraper-airbnb/listingPage';
import { LAYERS } from '@anchorage-str-db/scraper-airbnb/listingPage';
import type { ParsedListing } from '@anchorage-str-db/scraper-airbnb/parse';
import type { PriceQuote } from '@anchorage-str-db/scraper-airbnb/priceQuotes';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

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
 * A listing with no successful entry in `pages` records `page_fetch_ok =
 * false` and NULL page columns. One with no successful entry in `quotes`
 * records NULL quote columns.
 *
 * `changed` and `retired` are read from the views so the run log matches
 * what later queries see.
 */
export async function recordObservations(
  db: Database,
  scrapeDate: IsoDate,
  parsed: readonly ParsedListing[],
  pages: readonly ListingPage[] = [],
  quotes: readonly PriceQuote[] = [],
): Promise<ObservationStats> {
  const byListing = new Map<bigint, ListingPage>();
  for (const page of pages) {
    if (!page.error) byListing.set(BigInt(page.listingId), page);
  }
  const quoteByListing = new Map<bigint, PriceQuote>();
  for (const quote of quotes) {
    if (!quote.error) quoteByListing.set(BigInt(quote.listingId), quote);
  }

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
    parsed.map((listing) => {
      const page = byListing.get(listing.listingId);
      const quote = quoteByListing.get(listing.listingId);
      return {
        listingId: listing.listingId,
        scrapeDate,
        name: listing.name,
        propertyTitle: listing.propertyTitle,
        locationLat: listing.lat,
        locationLng: listing.lng,
        url: listing.url,
        badges: [...listing.badges],
        ratingValue: listing.ratingValue,
        reviewCount: listing.reviewCount,
        priceHintPerNight: listing.priceHintPerNight,
        priceQualifier: listing.priceQualifier,
        pageFetchOk: page !== undefined,
        locationIsExact: page?.locationIsExact ?? null,
        locationExactAddress: page?.locationExactAddress ?? null,
        locationSubtitle: page?.locationSubtitle ?? null,
        locationVerified: page?.locationVerified ?? null,
        registrationId: page?.registrationId ?? null,
        hostId: page?.hostId == null ? null : BigInt(page.hostId),
        listingType: page?.listingType ?? null,
        guestCapacity: page?.guestCapacity ?? null,
        beds: page?.beds ?? null,
        bedrooms: page?.bedrooms ?? null,
        bathrooms: page?.bathrooms ?? null,
        quoteCheckIn: quote?.checkIn ?? null,
        quoteNights: quote?.nights ?? null,
        quoteTotal: quote?.total ?? null,
        quoteLabel: quote?.label ?? null,
        quoteBreakdown: quote ? [...quote.breakdown] : null,
      };
    }),
  );

  await recordPhotos(
    db,
    scrapeDate,
    parsed.flatMap((listing) => {
      const urls = byListing.get(listing.listingId)?.photoUrls;
      return urls ? [{ listingId: listing.listingId, urls }] : [];
    }),
  );

  return {
    seen: parsed.length,
    new: parsed.filter((listing) => !previouslySeen.has(listing.listingId)).length,
    changed: await db.count(
      'SELECT count(*) FROM listing_versions WHERE valid_from = CAST(? AS DATE)',
      [scrapeDate],
    ),
    retired: await countNewlyRetired(db, scrapeDate, RETIREMENT_GRACE_DAYS),
  };
}

/**
 * Write each listing's photo set if it differs from the listing's previous
 * one, including a change of order. A page read without photos writes
 * nothing, so the previous set stays current.
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
    WHERE prev.photo_urls IS DISTINCT FROM s.photo_urls
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

/**
 * One run's listing-page pass, summarized for logging and the quality
 * checks. Which extraction layer produced a value is not stored in the
 * database.
 */
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
  /**
   * How many fetched pages yielded the exact-location flag, and how many
   * each extraction layer contributed to. The checks use these to detect a
   * layer that stopped working.
   */
  withExactFlag: number;
  layerUsed: Record<Layer, number>;
}

export function emptyPageStats(): PageFetchStats {
  return {
    attempted: 0,
    failed: 0,
    exactLocated: 0,
    registered: 0,
    withHostId: 0,
    withListingType: 0,
    withGuestCapacity: 0,
    withBeds: 0,
    withBedrooms: 0,
    withBathrooms: 0,
    withPhotos: 0,
    withExactFlag: 0,
    layerUsed: { 'json-ld': 0, state: 0, 'raw-html': 0 },
  };
}

export function summarizePages(pages: readonly ListingPage[]): PageFetchStats {
  const ok = pages.filter((page) => !page.error);
  const layerUsed = { 'json-ld': 0, state: 0, 'raw-html': 0 } satisfies Record<Layer, number>;
  for (const layer of LAYERS) {
    layerUsed[layer] = ok.filter((page) =>
      (page.locationSource ?? '').split('+').includes(layer),
    ).length;
  }
  return {
    attempted: pages.length,
    failed: pages.length - ok.length,
    exactLocated: ok.filter((page) => page.locationIsExact === true).length,
    registered: ok.filter((page) => page.registrationId !== null).length,
    withHostId: ok.filter((page) => page.hostId !== null).length,
    withListingType: ok.filter((page) => page.listingType !== null).length,
    withGuestCapacity: ok.filter((page) => page.guestCapacity !== null).length,
    withBeds: ok.filter((page) => page.beds !== null).length,
    withBedrooms: ok.filter((page) => page.bedrooms !== null).length,
    withBathrooms: ok.filter((page) => page.bathrooms !== null).length,
    withPhotos: ok.filter((page) => page.photoUrls !== null).length,
    withExactFlag: ok.filter((page) => page.locationIsExact !== null).length,
    layerUsed,
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

export function summarizeQuotes(quotes: readonly PriceQuote[]): QuoteStats {
  const ok = quotes.filter((quote) => !quote.error);
  return {
    attempted: quotes.length,
    failed: quotes.length - ok.length,
    priced: ok.filter((quote) => quote.total !== null).length,
  };
}

// --------------------------------------------------------------------------
// hosts

export interface HostProfileStats {
  /** Distinct hosts of a listing observed today. */
  attempted: number;
  /** Of those, how many had no card read today. */
  failed: number;
  /** Of those, how many had no profile listings read today. */
  listingsFailed: number;
  new: number;
  changed: number;
}

/**
 * The hosts `recordHostObservations` will write a row for, known before the
 * write phase so the profile-listings pass can request each one: the host a
 * page read today names, and for a listing whose page failed, the host its
 * current version carries forward. `pages` holds every listing observed
 * today.
 */
export async function hostsToRead(db: Database, pages: readonly ListingPage[]): Promise<string[]> {
  const hostIds = new Set<string>();
  for (const page of pages) {
    if (!page.error && page.hostId !== null) hostIds.add(page.hostId);
  }
  const unread = pages.filter((page) => page.error).map((page) => page.listingId);
  if (unread.length) {
    const carried = await db.rows<{ host_id: string }>(
      'SELECT DISTINCT host_id FROM listings ' +
        'WHERE valid_to IS NULL AND host_id IS NOT NULL ' +
        "AND listing_id IN (SELECT unnest(string_split(?, ','))::BIGINT)",
      [unread.join(',')],
    );
    for (const row of carried) hostIds.add(row.host_id);
  }
  return [...hostIds];
}

/**
 * Write one day's host observations: a row for every host of a listing
 * observed today, whether or not their card was read.
 *
 * Runs after `recordObservations` for the same date, in the same transaction:
 * today's owners are read back from `listings`, so a listing whose page failed
 * today still names its owner through the carried-forward `host_id`.
 *
 * `cards` is `collectHostCards`' output, and `listingsOnAirbnb` each host's
 * profile listing count from the profile-listings pass; a host missing from
 * either is recorded as unread for it. Idempotent per scrape date.
 */
export async function recordHostObservations(
  db: Database,
  scrapeDate: IsoDate,
  cards: ReadonlyMap<string, HostCard>,
  listingsOnAirbnb: ReadonlyMap<string, number> = new Map(),
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
        listingsOnAirbnbReadOk: listingsOnAirbnb.has(hostId),
        listingsOnAirbnb: listingsOnAirbnb.get(hostId) ?? null,
      };
    }),
  );

  return {
    attempted: hostIds.length,
    failed: hostIds.filter((hostId) => !cards.has(hostId)).length,
    listingsFailed: hostIds.filter((hostId) => !listingsOnAirbnb.has(hostId)).length,
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
  results: readonly CalendarResult[],
): Promise<CalendarMergeStats> {
  const stats: CalendarMergeStats = {
    attempted: results.length,
    failed: results.filter((result) => result.error).length,
    nightsChanged: 0,
  };
  const usable = results.filter((result) => !result.error);
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
 * caps how many are attempted.
 */
export async function pendingFirstReviews(
  db: Database,
  listings: readonly ParsedListing[],
): Promise<FirstReviewCandidate[]> {
  const resolved = new Set(
    (
      await db.rows<{ listing_id: string }>('SELECT listing_id FROM airbnb_listing_first_reviews')
    ).map((row) => BigInt(row.listing_id)),
  );
  return listings
    .filter((listing) => !resolved.has(listing.listingId))
    .sort((a, b) => (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0))
    .map((listing) => ({
      listingId: String(listing.listingId),
      reviewCountHint: listing.reviewCount,
    }));
}

export interface FirstReviewStats {
  attempted: number;
  failed: number;
  /** Resolved listings that have at least one review. */
  withReviews: number;
}

export function summarizeFirstReviews(results: readonly FirstReviewResult[]): FirstReviewStats {
  const ok = results.filter((result) => !result.error);
  return {
    attempted: results.length,
    failed: results.length - ok.length,
    withReviews: ok.filter((result) => result.firstReviewDate !== null).length,
  };
}

/**
 * Store each successful resolution. Failed results write nothing, so the
 * listing stays pending. Throws on a listing that is already resolved, which
 * `pendingFirstReviews` never returns.
 */
export async function recordFirstReviews(
  db: Database,
  scrapeDate: IsoDate,
  results: readonly FirstReviewResult[],
): Promise<void> {
  const ok = results.filter((result) => !result.error);
  if (ok.length === 0) return;
  await db.appendRows(
    airbnbListingFirstReviews,
    ok.map((result) => ({
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
