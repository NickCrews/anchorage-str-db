/** The overview's queries: the stat cards and the charts below them. */

import {
  airbnbListingFirstReviews,
  airbnbListingObservations,
  airbnbScrapeRuns,
} from '@anchorage-str-db/db/schema';
import { qb } from '@anchorage-str-db/db/sql';
import {
  calendarCurrent,
  latestRegistryDate,
  listings,
  listingsActive,
  listingsActiveWithRegistration,
  registrationsActive,
} from '@anchorage-str-db/db/viewSchema';
import { asc, eq, gte, sql } from 'drizzle-orm';

// Each of these is a one-row subquery the KPI row cross-joins. The name a
// column is read by is given where it is computed, so every reference to it
// after that is the schema's rather than a string.

/** Tonight's calendar: how many listings have a row for tonight, and how many are not available. */
const tonight = qb
  .select({
    withCalendarTonight: sql<number>`count(*)::INT`.as('withCalendarTonight'),
    notAvailableTonight:
      sql<number>`count(*) FILTER (WHERE NOT ${calendarCurrent.available})::INT`.as(
        'notAvailableTonight',
      ),
  })
  .from(calendarCurrent)
  .where(eq(calendarCurrent.nightDate, sql`CURRENT_DATE`))
  .as('tonight');

const active = qb
  .select({ activeListings: sql<number>`count(*)::INT`.as('activeListings') })
  .from(listings)
  .where(eq(listings.isActive, true))
  .as('active');

const lastYear = qb
  .select({
    distinctListingsLastYear:
      sql<number>`count(DISTINCT ${airbnbListingObservations.listingId})::INT`.as(
        'distinctListingsLastYear',
      ),
  })
  .from(airbnbListingObservations)
  .where(
    gte(airbnbListingObservations.scrapeDate, sql`CURRENT_DATE - INTERVAL 365 DAY`),
  )
  .as('last_year');

const latestRun = qb
  .select({
    latestScrapeDate: sql<number | null>`max(${airbnbScrapeRuns.scrapeDate})`.as(
      'latestScrapeDate',
    ),
  })
  .from(airbnbScrapeRuns)
  .as('latest_run');

const registry = qb
  .select({ registrationsActive: sql<number>`count(*)::INT`.as('registrationsActive') })
  .from(registrationsActive)
  .as('registry');

const registryDate = qb
  .select({
    latestRegistryDate: sql<number | null>`${latestRegistryDate.scrapeDate}`.as(
      'latestRegistryDate',
    ),
  })
  .from(latestRegistryDate)
  .as('registry_date');

const registered = qb
  .select({ listingsRegistered: sql<number>`count(*)::INT`.as('listingsRegistered') })
  .from(listingsActiveWithRegistration)
  .where(eq(listingsActiveWithRegistration.registrationIsActive, true))
  .as('registered');

export const KPI_FIELDS = {
  activeListings: active.activeListings,
  withCalendarTonight: tonight.withCalendarTonight,
  notAvailableTonight: tonight.notAvailableTonight,
  distinctListingsLastYear: lastYear.distinctListingsLastYear,
  latestScrapeDate: latestRun.latestScrapeDate,
  registrationsActive: registry.registrationsActive,
  listingsRegistered: registered.listingsRegistered,
  latestRegistryDate: registryDate.latestRegistryDate,
};

/** The header's stat cards: one row, each column a count from its own subquery. */
export const KPI_QUERY = qb
  .select(KPI_FIELDS)
  .from(active)
  .crossJoin(tonight)
  .crossJoin(lastYear)
  .crossJoin(latestRun)
  .crossJoin(registry)
  .crossJoin(registryDate)
  .crossJoin(registered);

export const AVAILABILITY_FIELDS = {
  nightDate: sql<number>`${calendarCurrent.nightDate}`.as('nightDate'),
  notAvailable: sql<number>`count(*) FILTER (WHERE NOT ${calendarCurrent.available})::INT`.as(
    'notAvailable',
  ),
  available: sql<number>`count(*) FILTER (WHERE ${calendarCurrent.available})::INT`.as(
    'available',
  ),
};

export const AVAILABILITY_QUERY = qb
  .select(AVAILABILITY_FIELDS)
  .from(calendarCurrent)
  .where(
    sql`${calendarCurrent.nightDate} BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL 90 DAY`,
  )
  .groupBy(sql`ALL`)
  .orderBy(asc(calendarCurrent.nightDate));

export const STR_TREND_FIELDS = {
  month: sql<number>`date_trunc('month', ${airbnbListingObservations.scrapeDate})::DATE`.as(
    'month',
  ),
  distinctListings: sql<number>`count(DISTINCT ${airbnbListingObservations.listingId})::INT`.as(
    'distinctListings',
  ),
};

export const STR_TREND_QUERY = qb
  .select(STR_TREND_FIELDS)
  .from(airbnbListingObservations)
  .groupBy(sql`ALL`)
  .orderBy(sql`"month"`);

/**
 * A listing's `first_available_date_est` comes from its first review when
 * that predates the first scrape, and is otherwise `first_seen_date`, which
 * makes a listing look newer than it may be.
 */
const datedByReview = sql`coalesce(${listingsActive.firstReviewDate} <= ${listingsActive.firstSeenDate}, false)`;

export const LISTING_AGE_FIELDS = {
  year: sql<string>`year(${listingsActive.firstAvailableDateEst})::VARCHAR`.as('year'),
  fromReview: sql<number>`count(*) FILTER (WHERE ${datedByReview})::INT`.as('fromReview'),
  fromFirstSeen: sql<number>`count(*) FILTER (WHERE NOT ${datedByReview})::INT`.as(
    'fromFirstSeen',
  ),
  reviewsUnread:
    sql<number>`count(*) FILTER (WHERE ${airbnbListingFirstReviews.listingId} IS NULL)::INT`.as(
      'reviewsUnread',
    ),
};

export const LISTING_AGE_QUERY = qb
  .select(LISTING_AGE_FIELDS)
  .from(listingsActive)
  .leftJoin(
    airbnbListingFirstReviews,
    eq(airbnbListingFirstReviews.listingId, listingsActive.listingId),
  )
  .groupBy(sql`ALL`)
  .orderBy(sql`"year"`);

/** `bedrooms` is Airbnb's text ("2 bedrooms", "Studio"); rooms usually have none. */
export const BEDROOM_MIX_FIELDS = {
  bedroomsLabel: sql<string>`coalesce(${listings.bedrooms}, 'Not listed')`.as(
    'bedroomsLabel',
  ),
  nListings: sql<number>`count(*)::INT`.as('nListings'),
};

export const BEDROOM_MIX_QUERY = qb
  .select(BEDROOM_MIX_FIELDS)
  .from(listings)
  .where(eq(listings.isActive, true))
  .groupBy(listings.bedrooms)
  .orderBy(
    sql`${listings.bedrooms} IS NULL`,
    sql`try_cast(regexp_extract(${listings.bedrooms}, '^\\d+') AS INTEGER) NULLS FIRST`,
    asc(listings.bedrooms),
  );
