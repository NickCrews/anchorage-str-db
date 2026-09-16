/**
 * Writes for the daily Airbnb run. The tables are defined in
 * `@anchorage-str-db/db/schema` and the views that read them in
 * `@anchorage-str-db/db/views`.
 */

import { bigint, day, duckDbType, varcharList } from '@anchorage-str-db/db/columns';
import type { Database } from '@anchorage-str-db/db/database';
import {
  airbnbCalendarStatus,
  airbnbHostObservations,
  airbnbListingFirstReviews,
  airbnbListingObservations,
  airbnbListingPhotos,
  airbnbScrapeRuns,
} from '@anchorage-str-db/db/schema';
import { qb, toSql } from '@anchorage-str-db/db/sql';
import {
  hostVersions,
  listingVersions,
  listings,
  RETIREMENT_GRACE_DAYS,
} from '@anchorage-str-db/db/viewSchema';
import type { CalendarResult } from '@anchorage-str-db/scraper-airbnb/calendars';
import type { FirstReviewCandidate, FirstReviewResult } from '@anchorage-str-db/scraper-airbnb/firstReviews';
import type { HostCard, Layer, ListingPage } from '@anchorage-str-db/scraper-airbnb/listingPage';
import { LAYERS } from '@anchorage-str-db/scraper-airbnb/listingPage';
import type { ParsedListing } from '@anchorage-str-db/scraper-airbnb/parse';
import type { PriceQuote } from '@anchorage-str-db/scraper-airbnb/priceQuotes';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { and, eq, getTableColumns, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias, boolean, integer, pgTable, varchar, type PgTable } from 'drizzle-orm/pg-core';

// --------------------------------------------------------------------------
// staging

/**
 * The temp tables a merge stages into, declared like any other table so the
 * statements that read them are checked the same way. `createStaging` builds
 * each one from its declaration, so what is appended and what is read cannot
 * drift from it.
 */
const stgPhotos = pgTable('stg_photos', {
  listingId: bigint('listing_id'),
  validFrom: day('valid_from'),
  photoUrls: varcharList('photo_urls'),
});

/** `status_hash` is filled in by `mergeCalendar` after the rows are appended. */
const stgCalendar = pgTable('stg_calendar', {
  listingId: bigint('listing_id'),
  nightDate: day('night_date'),
  available: boolean('available'),
  minNights: integer('min_nights'),
  statusHash: varchar('status_hash'),
});

async function createStaging(db: Database, table: PgTable): Promise<void> {
  const columns = Object.values(getTableColumns(table)).map(
    (column) => sql`${sql.identifier(column.name)} ${sql.raw(duckDbType(column))}`,
  );
  await db.run(
    toSql(sql`CREATE OR REPLACE TEMP TABLE ${table} (${sql.join(columns, sql`, `)})`),
  );
}

const dropStaging = (db: Database, table: PgTable): Promise<void> =>
  db.run(toSql(sql`DROP TABLE ${table}`));

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
  const byRoom = new Map<bigint, ListingPage>();
  for (const page of pages) {
    if (!page.error) byRoom.set(BigInt(page.roomId), page);
  }
  const quoteByRoom = new Map<bigint, PriceQuote>();
  for (const quote of quotes) {
    if (!quote.error) quoteByRoom.set(BigInt(quote.roomId), quote);
  }

  await db.orm
    .delete(airbnbListingObservations)
    .where(eq(airbnbListingObservations.scrapeDate, scrapeDate));
  // After the delete, so a re-run doesn't count its own earlier rows as history.
  const previouslySeen = new Set(
    (
      await db.orm
        .selectDistinct({ listingId: airbnbListingObservations.listingId })
        .from(airbnbListingObservations)
    ).map((row) => row.listingId),
  );

  await db.appendRows(
    airbnbListingObservations,
    parsed.map((listing) => {
      const page = byRoom.get(listing.listingId);
      const quote = quoteByRoom.get(listing.listingId);
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
        strRegistrationId: page?.strRegistrationId ?? null,
        hostId: page?.hostId == null ? null : BigInt(page.hostId),
        roomType: page?.roomType ?? null,
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
      const urls = byRoom.get(listing.listingId)?.photoUrls;
      return urls ? [{ listingId: listing.listingId, urls }] : [];
    }),
  );

  return {
    seen: parsed.length,
    new: parsed.filter((listing) => !previouslySeen.has(listing.listingId)).length,
    changed: await db.orm.$count(listingVersions, eq(listingVersions.validFrom, scrapeDate)),
    retired: await countNewlyRetired(db, scrapeDate, RETIREMENT_GRACE_DAYS),
  };
}

/**
 * Each listing's photo set as of the day before `scrapeDate`: the CTE
 * `recordPhotos` compares against. Its body is DuckDB's `QUALIFY`, so it is
 * written as SQL over the schema's columns, with the columns it returns
 * declared as the ones it selects.
 */
const previousPhotos = (scrapeDate: IsoDate) =>
  qb
    .$with('prev', {
      listingId: airbnbListingPhotos.listingId,
      photoUrls: airbnbListingPhotos.photoUrls,
    })
    .as(
      sql`SELECT ${airbnbListingPhotos.listingId}, ${airbnbListingPhotos.photoUrls}
          FROM ${airbnbListingPhotos}
          WHERE ${lt(airbnbListingPhotos.validFrom, scrapeDate)}
          QUALIFY row_number() OVER (
            PARTITION BY ${airbnbListingPhotos.listingId}
            ORDER BY ${airbnbListingPhotos.validFrom} DESC
          ) = 1`,
    );

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
  await db.orm.delete(airbnbListingPhotos).where(eq(airbnbListingPhotos.validFrom, scrapeDate));
  if (sets.length === 0) return;

  await createStaging(db, stgPhotos);
  await db.appendRows(
    stgPhotos,
    sets.map((set) => ({ listingId: set.listingId, validFrom: scrapeDate, photoUrls: [...set.urls] })),
  );

  const prev = previousPhotos(scrapeDate);
  await db.orm.insert(airbnbListingPhotos).select(
    qb
      .with(prev)
      .select({
        listingId: stgPhotos.listingId,
        validFrom: stgPhotos.validFrom,
        photoUrls: stgPhotos.photoUrls,
      })
      .from(stgPhotos)
      .leftJoin(prev, eq(prev.listingId, stgPhotos.listingId))
      .where(sql`${prev.photoUrls} IS DISTINCT FROM ${stgPhotos.photoUrls}`),
  );
  await dropStaging(db, stgPhotos);
}

/**
 * How many listings became retired on this date: those last observed
 * exactly `grace + 1` days ago.
 *
 * Assumes daily runs. A gap shifts which run reports the retirement but not
 * whether the listing is current.
 */
export async function countNewlyRetired(
  db: Database,
  scrapeDate: IsoDate,
  graceDays: number,
): Promise<number> {
  const lastSeen = addDays(scrapeDate, -(graceDays + 1));
  return db.orm.$count(
    qb
      .select({ listingId: airbnbListingObservations.listingId })
      .from(airbnbListingObservations)
      .groupBy(airbnbListingObservations.listingId)
      .having(eq(sql`max(${airbnbListingObservations.scrapeDate})`, lastSeen))
      .as('retired'),
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
  withRoomType: number;
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
    withRoomType: 0,
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
    registered: ok.filter((page) => page.strRegistrationId !== null).length,
    withHostId: ok.filter((page) => page.hostId !== null).length,
    withRoomType: ok.filter((page) => page.roomType !== null).length,
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
  /** Distinct hosts owning a listing observed today. */
  attempted: number;
  /** Of those, how many had no card read today. */
  failed: number;
  new: number;
  changed: number;
}

/**
 * Write one day's host observations: a row for every host owning a listing
 * observed today, whether or not their card was read.
 *
 * Runs after `recordObservations` for the same date, in the same transaction:
 * today's owners are read back from `listings`, so a listing whose page failed
 * today still names its owner through the carried-forward `host_id`.
 *
 * `cards` is `collectHostCards`' output. Idempotent per scrape date.
 */
export async function recordHostObservations(
  db: Database,
  scrapeDate: IsoDate,
  cards: ReadonlyMap<string, HostCard>,
): Promise<HostProfileStats> {
  await db.orm
    .delete(airbnbHostObservations)
    .where(eq(airbnbHostObservations.scrapeDate, scrapeDate));
  const previouslySeen = new Set(
    (
      await db.orm
        .selectDistinct({ hostId: airbnbHostObservations.hostId })
        .from(airbnbHostObservations)
    ).map((row) => String(row.hostId)),
  );
  const owners = (
    await db.orm
      .selectDistinct({ hostId: listings.hostId })
      .from(listings)
      .where(
        and(
          isNull(listings.validTo),
          eq(listings.lastSeenDate, scrapeDate),
          isNotNull(listings.hostId),
        ),
      )
  ).map((row) => String(row.hostId));
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
    changed: await db.orm.$count(hostVersions, eq(hostVersions.validFrom, scrapeDate)),
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

  await createStaging(db, stgCalendar);
  await db.appendRows(
    stgCalendar,
    usable.flatMap((result) =>
      result.nights.map((night) => ({
        listingId: BigInt(result.roomId),
        nightDate: night.nightDate,
        available: night.available,
        minNights: night.minNights,
        statusHash: null,
      })),
    ),
  );

  // The trailing '|' is part of the hash format of every stored row. Changing
  // the format would re-version every current night on the next run.
  await db.orm.update(stgCalendar).set({
    statusHash: sql`md5(${stgCalendar.available}::VARCHAR || '|' || coalesce(${stgCalendar.minNights}::VARCHAR,'') || '|')`,
  });

  /** The current stored row for a staged night, where there is one. */
  const current = alias(airbnbCalendarStatus, 'c');
  const sameNight = and(
    eq(current.listingId, stgCalendar.listingId),
    eq(current.nightDate, stgCalendar.nightDate),
    eq(current.isCurrent, true),
  );

  stats.nightsChanged = await db.orm.$count(
    qb
      .select({ listingId: stgCalendar.listingId })
      .from(stgCalendar)
      .leftJoin(current, sameNight)
      .where(
        or(isNull(current.listingId), ne(current.statusHash, stgCalendar.statusHash)),
      )
      .as('changed'),
  );
  if (stats.nightsChanged === 0) return stats;

  const changedNights = qb
    .select({ listingId: stgCalendar.listingId, nightDate: stgCalendar.nightDate })
    .from(stgCalendar)
    .innerJoin(current, sameNight)
    .where(ne(current.statusHash, stgCalendar.statusHash));

  await db.orm
    .update(airbnbCalendarStatus)
    .set({ validTo: scrapeDate, isCurrent: false })
    .where(
      and(
        eq(airbnbCalendarStatus.isCurrent, true),
        sql`(${airbnbCalendarStatus.listingId}, ${airbnbCalendarStatus.nightDate}) IN (${changedNights})`,
      ),
    );

  // Changed nights no longer have a current row, so this inserts exactly
  // the new and changed ones.
  await db.orm.insert(airbnbCalendarStatus).select(
    qb
      .select({
        listingId: stgCalendar.listingId,
        nightDate: stgCalendar.nightDate,
        available: stgCalendar.available,
        minNights: stgCalendar.minNights,
        statusHash: stgCalendar.statusHash,
        validFrom: sql`${scrapeDate}`.as('valid_from'),
        validTo: sql`NULL`.as('valid_to'),
        isCurrent: sql`true`.as('is_current'),
      })
      .from(stgCalendar)
      .leftJoin(current, sameNight)
      .where(isNull(current.listingId)),
  );
  await dropStaging(db, stgCalendar);
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
      await db.orm
        .select({ listingId: airbnbListingFirstReviews.listingId })
        .from(airbnbListingFirstReviews)
    ).map((row) => row.listingId),
  );
  return listings
    .filter((listing) => !resolved.has(listing.listingId))
    .sort((a, b) => (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0))
    .map((listing) => ({
      roomId: String(listing.listingId),
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
      listingId: BigInt(result.roomId),
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
