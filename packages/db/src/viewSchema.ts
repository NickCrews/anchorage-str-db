/**
 * The views: what each one returns, and the query that builds it.
 *
 * Everything downstream reads these rather than the tables in `schema.ts`.
 * `listings` is derived from `airbnb_listing_observations`: `listingVersions`
 * rebuilds `valid_from`/`valid_to` with gaps-and-islands, and
 * `listingActivity` derives first/last/page-seen dates. Deriving keeps those
 * dates consistent with the observations (including for relisted listings)
 * and lets a version-logic bug be fixed by editing a view rather than
 * backfilling the only copy of the archive. `hosts` is built from
 * `airbnb_host_observations` the same way. `registrations` has one row per
 * registration with its latest license page, and
 * `listingsActiveWithRegistration` joins Airbnb listings to it on the
 * registration id. Cleaning (the `'None'` business name, the no-match
 * placeholder coordinate) happens here, so the raw tables can always be
 * re-derived.
 *
 * Each view is declared with its columns and defined with its query, so the
 * two sit together and every relation and column either names is the
 * schema's. `views.ts` renders them to the `CREATE OR REPLACE VIEW` script
 * `connect` runs on every open, which is what lets a change here land without
 * a migration.
 *
 * The queries are built with Drizzle's query builder where the Postgres
 * dialect can express them, and the DuckDB syntax it has no notion of —
 * `SELECT * EXCLUDE`, `* REPLACE`, `QUALIFY`, struct version keys, list
 * comprehensions — goes in a `sql` fragment inside the query, or as the body
 * of a `$with` CTE whose columns are declared. So a renamed or retyped column
 * is a type error here, and a change that alters what a view returns is
 * caught on the next `connect`: it compares every declaration below against
 * the view DuckDB built, column for column, and refuses the database if they
 * differ.
 *
 * Every column is nullable. DuckDB reports no nullability for a view, so a
 * `notNull()` here would be an unchecked claim, and most of these columns
 * really can be NULL: a listing whose page was never read has no `listing_type`,
 * a registration the geocoder could not place has no `geocoded_lat`.
 *
 * Nothing here reaches a driver, so the viewer builds its queries from the
 * same objects the scraper's writes and checks do. See the README for which
 * modules are safe to import in a browser.
 */

import { NO_MATCH_GEOCODED_ADDRESS } from '@anchorage-str-db/scraper-muni-str/noMatch';
import {
  and,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  sql,
  type Column,
  type SQL,
} from 'drizzle-orm';
import { boolean, doublePrecision, integer, pgView, varchar } from 'drizzle-orm/pg-core';

import { bigint, day, hugeint, naiveTimestamp, structList, varcharList } from './columns.ts';
import { columnsOf, derived, qb } from './sql.ts';
import {
  airbnbCalendarStatus,
  airbnbHostObservations,
  airbnbListingFirstReviews,
  airbnbListingObservations,
  airbnbListingPhotos,
  airbnbScrapeRuns,
  LICENSE_ISSUANCES_TYPE,
  LICENSE_LOCATIONS_TYPE,
  muniLicensePageReads,
  muniStrRegistrationObservations,
  muniStrRegistryRuns,
  type LicenseIssuance,
  type LicenseLocation,
} from './schema.ts';

/**
 * Days a listing may be absent from search before `listings.is_active` goes
 * false. Search occasionally omits a listing for a day.
 */
export const RETIREMENT_GRACE_DAYS = 5;

/** The listing and host activity views measure "active" from this date. */
const withinGrace = (lastSeen: SQL | Column): SQL<boolean> =>
  sql`${lastSeen} >= (${qb
    .select({ scrapeDate: latestScrapeDate.scrapeDate })
    .from(latestScrapeDate)}) - INTERVAL ${sql.raw(String(RETIREMENT_GRACE_DAYS))} DAY`;

// --------------------------------------------------------------------------
// Airbnb

/**
 * The date retirement is measured from: the latest run that completed its
 * writes. Observations alone would stop advancing on a day with no listings;
 * `airbnb_scrape_runs` alone would include failed runs, whose counts are NULL.
 */
export const latestScrapeDate = pgView('latest_scrape_date', {
  scrapeDate: day('scrape_date'),
}).as(
  sql`SELECT max(scrape_date) AS scrape_date FROM (
    ${qb
      .select({ scrapeDate: sql`max(${airbnbListingObservations.scrapeDate})`.as('scrape_date') })
      .from(airbnbListingObservations)}
    UNION ALL
    ${qb
      .select({ scrapeDate: sql`max(${airbnbScrapeRuns.scrapeDate})`.as('scrape_date') })
      .from(airbnbScrapeRuns)
      .where(isNotNull(airbnbScrapeRuns.listingsSeen))}
  )`,
);

/**
 * Per listing: first and last seen, last successful page read, and whether
 * active. A listing is active if it was seen within `RETIREMENT_GRACE_DAYS`
 * of the latest scrape, because search occasionally omits a listing for a day.
 */
export const listingActivity = pgView('listing_activity', {
  listingId: bigint('listing_id'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  pageSeenDate: day('page_seen_date'),
  isActive: boolean('is_active'),
}).as(
  sql`${qb
    .select({
      listingId: airbnbListingObservations.listingId,
      firstSeenDate: sql`min(${airbnbListingObservations.scrapeDate})`.as('first_seen_date'),
      lastSeenDate: sql`max(${airbnbListingObservations.scrapeDate})`.as('last_seen_date'),
      pageSeenDate:
        sql`max(${airbnbListingObservations.scrapeDate}) FILTER (WHERE ${airbnbListingObservations.pageFetchOk})`.as(
          'page_seen_date',
        ),
      isActive: withinGrace(sql`max(${airbnbListingObservations.scrapeDate})`).as('is_active'),
    })
    .from(airbnbListingObservations)
    .groupBy(airbnbListingObservations.listingId)}`,
);

/**
 * The attributes whose change opens a new listing version. Excludes values
 * that change most days (rating, review count, price hint) and `url`, which
 * is derived from `listing_id`. Coordinates are rounded to 6dp so float noise
 * doesn't open a version. `page_attrs` holds the listing-page fields, so a
 * listing changing hands, converting from a whole home to a private room, or
 * changing its guest, bed, bedroom or bathroom count opens a version. The
 * price quote changes most days and is not part of it. Photos are stored
 * separately and never open one: hosts reorder and replace photos far more
 * often than the listing itself changes.
 */
const VERSION_KEY = sql`{
    'name': name,
    'property_title': property_title,
    'lat': round(location_lat, 6),
    'lng': round(location_lng, 6),
    'badges': list_sort(badges),
    'page': page_attrs
}`;

const PAGE_ATTRS = sql`{
    'location_is_exact': ${airbnbListingObservations.locationIsExact},
    'location_exact_address': ${airbnbListingObservations.locationExactAddress},
    'location_subtitle': ${airbnbListingObservations.locationSubtitle},
    'location_verified': ${airbnbListingObservations.locationVerified},
    'registration_id': ${airbnbListingObservations.registrationId},
    'host_id': ${airbnbListingObservations.hostId},
    'listing_type': ${airbnbListingObservations.listingType},
    'guest_capacity': ${airbnbListingObservations.guestCapacity},
    'beds': ${airbnbListingObservations.beds},
    'bedrooms': ${airbnbListingObservations.bedrooms},
    'bathrooms': ${airbnbListingObservations.bathrooms}
}`;

/**
 * SCD2 versions: a version runs from the first day an attribute set was
 * observed until the next distinct set appears.
 *
 * The chain carries the page fields forward as one struct, which keeps "read
 * the page, no registration id" (a struct holding a NULL) distinct from
 * "page not read" (a NULL struct), and is what `SELECT * EXCLUDE`,
 * `* REPLACE` and a windowed `IS DISTINCT FROM` are for: DuckDB SQL through
 * and through, so the body below is SQL over the schema's columns.
 */
export const listingVersions = pgView('listing_versions', {
  listingId: bigint('listing_id'),
  versionNo: hugeint('version_no'),
  validFrom: day('valid_from'),
  versionLastSeenDate: day('version_last_seen_date'),
  name: varchar('name'),
  propertyTitle: varchar('property_title'),
  locationLat: doublePrecision('location_lat'),
  locationLng: doublePrecision('location_lng'),
  url: varchar('url'),
  badges: varcharList('badges'),
  locationIsExact: boolean('location_is_exact'),
  locationExactAddress: varchar('location_exact_address'),
  locationSubtitle: varchar('location_subtitle'),
  locationVerified: boolean('location_verified'),
  registrationId: varchar('registration_id'),
  hostId: bigint('host_id'),
  listingType: varchar('listing_type'),
  guestCapacity: integer('guest_capacity'),
  beds: integer('beds'),
  bedrooms: varchar('bedrooms'),
  bathrooms: varchar('bathrooms'),
  validTo: day('valid_to'),
}).as(
  sql`WITH observed AS (
    SELECT
        * EXCLUDE (
            location_is_exact, location_exact_address, location_subtitle,
            location_verified, registration_id, host_id,
            listing_type, guest_capacity, beds, bedrooms, bathrooms
        ),
        -- NULL when the page fetch failed, so the carry-forward skips it.
        CASE WHEN ${airbnbListingObservations.pageFetchOk} THEN ${PAGE_ATTRS} END AS page_attrs
    FROM ${airbnbListingObservations}
),
carried AS (
    SELECT * REPLACE (
        last_value(page_attrs IGNORE NULLS) OVER (
            PARTITION BY listing_id ORDER BY scrape_date
        ) AS page_attrs
    )
    FROM observed
),
keyed AS (
    SELECT *, ${VERSION_KEY} AS version_key FROM carried
),
marked AS (
    SELECT *,
        CASE WHEN version_key IS DISTINCT FROM lag(version_key) OVER w
             THEN 1 ELSE 0 END AS opens_version
    FROM keyed
    WINDOW w AS (PARTITION BY listing_id ORDER BY scrape_date)
),
numbered AS (
    SELECT *,
        sum(opens_version) OVER (PARTITION BY listing_id ORDER BY scrape_date)
            AS version_no
    FROM marked
),
-- Every row in a group has the same version_key, so any_value is exact.
aggregated AS (
    SELECT
        listing_id,
        version_no,
        min(scrape_date) AS valid_from,
        max(scrape_date) AS version_last_seen_date,
        any_value(name) AS name,
        any_value(property_title) AS property_title,
        any_value(location_lat) AS location_lat,
        any_value(location_lng) AS location_lng,
        any_value(url) AS url,
        any_value(badges) AS badges,
        any_value(page_attrs) AS page_attrs
    FROM numbered
    GROUP BY listing_id, version_no
)
SELECT
    * EXCLUDE (page_attrs),
    page_attrs.location_is_exact AS location_is_exact,
    page_attrs.location_exact_address AS location_exact_address,
    page_attrs.location_subtitle AS location_subtitle,
    page_attrs.location_verified AS location_verified,
    page_attrs.registration_id AS registration_id,
    page_attrs.host_id AS host_id,
    page_attrs.listing_type AS listing_type,
    page_attrs.guest_capacity AS guest_capacity,
    page_attrs.beds AS beds,
    page_attrs.bedrooms AS bedrooms,
    page_attrs.bathrooms AS bathrooms,
    lead(valid_from) OVER (PARTITION BY listing_id ORDER BY version_no) AS valid_to
FROM aggregated`,
);

/**
 * `listings` and everything built on it start from these columns, in this
 * order, because each of those views selects them and appends its own.
 */
const listingColumns = {
  listingId: bigint('listing_id'),
  name: varchar('name'),
  propertyTitle: varchar('property_title'),
  listingType: varchar('listing_type'),
  guestCapacity: integer('guest_capacity'),
  beds: integer('beds'),
  bedrooms: varchar('bedrooms'),
  bathrooms: varchar('bathrooms'),
  locationLat: doublePrecision('location_lat'),
  locationLng: doublePrecision('location_lng'),
  url: varchar('url'),
  badges: varcharList('badges'),
  locationIsExact: boolean('location_is_exact'),
  locationExactAddress: varchar('location_exact_address'),
  locationSubtitle: varchar('location_subtitle'),
  locationVerified: boolean('location_verified'),
  registrationId: varchar('registration_id'),
  hostId: bigint('host_id'),
  pageSeenDate: day('page_seen_date'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  firstReviewDate: day('first_review_date'),
  firstAvailableDateEst: day('first_available_date_est'),
  versionNo: hugeint('version_no'),
  versionLastSeenDate: day('version_last_seen_date'),
  validFrom: day('valid_from'),
  validTo: day('valid_to'),
  isActive: boolean('is_active'),
} as const;

/** Every listing version ever observed: the dimension downstream queries read. */
export const listings = pgView('listings', listingColumns).as(
  sql`${qb
    .select({
      listingId: listingVersions.listingId,
      name: listingVersions.name,
      propertyTitle: listingVersions.propertyTitle,
      listingType: listingVersions.listingType,
      guestCapacity: listingVersions.guestCapacity,
      beds: listingVersions.beds,
      bedrooms: listingVersions.bedrooms,
      bathrooms: listingVersions.bathrooms,
      locationLat: listingVersions.locationLat,
      locationLng: listingVersions.locationLng,
      url: listingVersions.url,
      badges: listingVersions.badges,
      locationIsExact: listingVersions.locationIsExact,
      locationExactAddress: listingVersions.locationExactAddress,
      locationSubtitle: listingVersions.locationSubtitle,
      locationVerified: listingVersions.locationVerified,
      registrationId: listingVersions.registrationId,
      hostId: listingVersions.hostId,
      pageSeenDate: listingActivity.pageSeenDate,
      firstSeenDate: listingActivity.firstSeenDate,
      lastSeenDate: listingActivity.lastSeenDate,
      firstReviewDate: airbnbListingFirstReviews.firstReviewDate,
      // The earlier of the first review and first_seen_date: the room was
      // listed on or before this date. An estimate, not the true listing
      // date: it can only be too late, never too early. A room with no
      // reviews from before this project saw it gets first_seen_date and
      // looks newer than it may be. `least` skips NULLs, so a listing with no
      // reviews, or not yet resolved, gets first_seen_date.
      firstAvailableDateEst:
        sql`least(${airbnbListingFirstReviews.firstReviewDate}, ${listingActivity.firstSeenDate})`.as(
          'first_available_date_est',
        ),
      versionNo: listingVersions.versionNo,
      versionLastSeenDate: listingVersions.versionLastSeenDate,
      validFrom: listingVersions.validFrom,
      validTo: listingVersions.validTo,
      isActive:
        sql`${listingVersions.validTo} IS NULL AND ${listingActivity.isActive}`.as('is_active'),
    })
    .from(listingVersions)
    .innerJoin(listingActivity, eq(listingActivity.listingId, listingVersions.listingId))
    .leftJoin(
      airbnbListingFirstReviews,
      eq(airbnbListingFirstReviews.listingId, listingVersions.listingId),
    )}`,
);

/** `listings` filtered to the current version of each active listing. */
export const listingsActive = pgView('listings_active', listingColumns).as(
  sql`${qb.select(columnsOf(listings)).from(listings).where(eq(listings.isActive, true))}`,
);

/** Each listing's most recent photo set; `photoUrls[1]` is the cover photo. */
export const listingPhotosCurrent = pgView('listing_photos_current', {
  listingId: bigint('listing_id'),
  photoUrls: varcharList('photo_urls'),
  photoCount: integer('photo_count'),
  photosValidFrom: day('photos_valid_from'),
}).as(
  sql`SELECT
    ${airbnbListingPhotos.listingId},
    ${airbnbListingPhotos.photoUrls},
    len(${airbnbListingPhotos.photoUrls})::INTEGER AS photo_count,
    ${airbnbListingPhotos.validFrom} AS photos_valid_from
FROM ${airbnbListingPhotos}
QUALIFY row_number() OVER (
    PARTITION BY ${airbnbListingPhotos.listingId}
    ORDER BY ${airbnbListingPhotos.validFrom} DESC
) = 1`,
);

/**
 * The current version of each night, minus the future nights of inactive
 * listings.
 *
 * An inactive listing's calendar is no longer fetched, so its future nights
 * stay `is_current` for up to twelve months. Nights up to its `last_seen_date`
 * are real observations and are kept.
 *
 * A (listing, night) with no row here is not a zero: the listing had not been
 * scraped yet, had retired, the night is past Airbnb's ~12-month window, or
 * its calendar was never read. Only the second is a fact about the rental,
 * and the missing row cannot say which applies.
 */
export const calendarCurrent = pgView('calendar_current', {
  listingId: bigint('listing_id'),
  nightDate: day('night_date'),
  available: boolean('available'),
  minNights: integer('min_nights'),
  statusHash: varchar('status_hash'),
  validFrom: day('valid_from'),
  validTo: day('valid_to'),
  isCurrent: boolean('is_current'),
}).as(
  sql`${qb
    .select({
      listingId: airbnbCalendarStatus.listingId,
      nightDate: airbnbCalendarStatus.nightDate,
      available: airbnbCalendarStatus.available,
      minNights: airbnbCalendarStatus.minNights,
      statusHash: airbnbCalendarStatus.statusHash,
      validFrom: airbnbCalendarStatus.validFrom,
      validTo: airbnbCalendarStatus.validTo,
      isCurrent: airbnbCalendarStatus.isCurrent,
    })
    .from(airbnbCalendarStatus)
    .innerJoin(listingActivity, eq(listingActivity.listingId, airbnbCalendarStatus.listingId))
    .where(
      and(
        eq(airbnbCalendarStatus.isCurrent, true),
        sql`(${listingActivity.isActive} OR ${airbnbCalendarStatus.nightDate} <= ${listingActivity.lastSeenDate})`,
      ),
    )}`,
);

/**
 * The start date one `timeAsHost` reading implies. Airbnb reports whole
 * months, so this lands up to a month after the true start depending on the
 * day of the month it was read. `hostActivity` takes the minimum over all
 * readings, which is why the start date is an aggregate rather than part of
 * the host version key.
 */
const IMPLIED_HOSTING_START = sql`(${airbnbHostObservations.scrapeDate} - to_months(
    12 * ${airbnbHostObservations.timeAsHostYears} + ${airbnbHostObservations.timeAsHostMonths}
))::DATE`;

/**
 * Per host: first and last seen, last card read, and whether active, on the
 * same rule as `listingActivity`. `hosting_started_on` is the earliest start
 * date any reading implies, and `hosting_start_spread_days` how far the
 * readings disagree. Month rounding alone keeps the spread under about a
 * month; the `host_start_date_stable` check warns beyond that.
 */
export const hostActivity = pgView('host_activity', {
  hostId: bigint('host_id'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  profileSeenDate: day('profile_seen_date'),
  hostingStartedOn: day('hosting_started_on'),
  hostingStartSpreadDays: integer('hosting_start_spread_days'),
  yearsHosting: integer('years_hosting'),
  isActive: boolean('is_active'),
}).as(
  sql`${qb
    .select({
      hostId: airbnbHostObservations.hostId,
      firstSeenDate: sql`min(${airbnbHostObservations.scrapeDate})`.as('first_seen_date'),
      lastSeenDate: sql`max(${airbnbHostObservations.scrapeDate})`.as('last_seen_date'),
      profileSeenDate:
        sql`max(${airbnbHostObservations.scrapeDate}) FILTER (WHERE ${airbnbHostObservations.profileReadOk})`.as(
          'profile_seen_date',
        ),
      hostingStartedOn:
        sql`min(${IMPLIED_HOSTING_START}) FILTER (WHERE ${airbnbHostObservations.profileReadOk})`.as(
          'hosting_started_on',
        ),
      hostingStartSpreadDays: sql`date_diff(
        'day',
        min(${IMPLIED_HOSTING_START}) FILTER (WHERE ${airbnbHostObservations.profileReadOk}),
        max(${IMPLIED_HOSTING_START}) FILTER (WHERE ${airbnbHostObservations.profileReadOk})
      )::INTEGER`.as('hosting_start_spread_days'),
      // Whole years of `timeAsHost` at the latest reading.
      yearsHosting: sql`arg_max(${airbnbHostObservations.timeAsHostYears}, ${airbnbHostObservations.scrapeDate})
        FILTER (WHERE ${airbnbHostObservations.profileReadOk} AND ${airbnbHostObservations.timeAsHostYears} IS NOT NULL)`.as(
        'years_hosting',
      ),
      isActive: withinGrace(sql`max(${airbnbHostObservations.scrapeDate})`).as('is_active'),
    })
    .from(airbnbHostObservations)
    .groupBy(airbnbHostObservations.hostId)}`,
);

/**
 * Gaps-and-islands over (name, about), as in `listingVersions`. A day whose
 * card was not read contributes a NULL profile, which the carry-forward
 * skips, so a failed read neither blanks the host nor opens a version.
 * `timeAsHost` grows monthly, so it is summarized in `hostActivity` rather
 * than versioned.
 */
export const hostVersions = pgView('host_versions', {
  hostId: bigint('host_id'),
  versionNo: hugeint('version_no'),
  validFrom: day('valid_from'),
  versionLastSeenDate: day('version_last_seen_date'),
  name: varchar('name'),
  about: varchar('about'),
  validTo: day('valid_to'),
}).as(
  sql`WITH observed AS (
    SELECT
        ${airbnbHostObservations.hostId},
        ${airbnbHostObservations.scrapeDate},
        CASE WHEN ${airbnbHostObservations.profileReadOk}
             THEN {'name': ${airbnbHostObservations.name}, 'about': ${airbnbHostObservations.about}} END AS profile
    FROM ${airbnbHostObservations}
),
carried AS (
    SELECT
        host_id,
        scrape_date,
        last_value(profile IGNORE NULLS) OVER (
            PARTITION BY host_id ORDER BY scrape_date
        ) AS profile
    FROM observed
),
-- Wrapped so "no card read yet" (a NULL profile) differs from lag()'s NULL
-- on the first row.
marked AS (
    SELECT *,
        CASE WHEN {'p': profile} IS DISTINCT FROM lag({'p': profile}) OVER w
             THEN 1 ELSE 0 END AS opens_version
    FROM carried
    WINDOW w AS (PARTITION BY host_id ORDER BY scrape_date)
),
numbered AS (
    SELECT *,
        sum(opens_version) OVER (PARTITION BY host_id ORDER BY scrape_date) AS version_no
    FROM marked
),
aggregated AS (
    SELECT
        host_id,
        version_no,
        min(scrape_date) AS valid_from,
        max(scrape_date) AS version_last_seen_date,
        any_value(profile) AS profile
    FROM numbered
    GROUP BY host_id, version_no
)
SELECT
    host_id,
    version_no,
    valid_from,
    version_last_seen_date,
    profile.name AS name,
    profile.about AS about,
    lead(valid_from) OVER (PARTITION BY host_id ORDER BY version_no) AS valid_to
FROM aggregated`,
);

/**
 * The host dimension. Join to `listings` on `hostId`; filter `isActive` for
 * one row per host.
 */
export const hosts = pgView('hosts', {
  hostId: bigint('host_id'),
  name: varchar('name'),
  about: varchar('about'),
  hostingStartedOn: day('hosting_started_on'),
  hostingStartedYear: integer('hosting_started_year'),
  yearsHosting: integer('years_hosting'),
  hostingStartSpreadDays: integer('hosting_start_spread_days'),
  profileSeenDate: day('profile_seen_date'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  versionNo: hugeint('version_no'),
  versionLastSeenDate: day('version_last_seen_date'),
  validFrom: day('valid_from'),
  validTo: day('valid_to'),
  isActive: boolean('is_active'),
}).as(
  sql`${qb
    .select({
      hostId: hostVersions.hostId,
      name: hostVersions.name,
      about: hostVersions.about,
      hostingStartedOn: hostActivity.hostingStartedOn,
      hostingStartedYear: sql`year(${hostActivity.hostingStartedOn})::INTEGER`.as(
        'hosting_started_year',
      ),
      yearsHosting: hostActivity.yearsHosting,
      hostingStartSpreadDays: hostActivity.hostingStartSpreadDays,
      profileSeenDate: hostActivity.profileSeenDate,
      firstSeenDate: hostActivity.firstSeenDate,
      lastSeenDate: hostActivity.lastSeenDate,
      versionNo: hostVersions.versionNo,
      versionLastSeenDate: hostVersions.versionLastSeenDate,
      validFrom: hostVersions.validFrom,
      validTo: hostVersions.validTo,
      isActive: sql`${hostVersions.validTo} IS NULL AND ${hostActivity.isActive}`.as(
        'is_active',
      ),
    })
    .from(hostVersions)
    .innerJoin(hostActivity, eq(hostActivity.hostId, hostVersions.hostId))}`,
);

/**
 * Listings per host per completed run date. Counts only: no threshold
 * marking a commercial host is stored; that line is drawn downstream.
 *
 * listings_active     listings held by the host that were live on
 *                     scrape_date: the `listingActivity.isActive` rule
 *                     evaluated as of that date.
 * listings_ever_seen  distinct listings observed under the host on or before
 *                     scrape_date, live or not.
 *
 * A row exists for every run date from the host's first observation on, so a
 * portfolio winding down reads as zeros rather than missing rows. A listing's
 * host is carried forward past failed page fetches as in `listingVersions`,
 * so the latest date agrees with `listingsActive.hostId`. A listing whose
 * page was never read has no known host and is counted under nobody.
 *
 * An Anchorage host listing portfolio: only the host's listings inside the
 * Municipality are counted, not the ones they hold elsewhere. That is a
 * limit of the data and not the question anyone is asking — a host running
 * forty units from Palmer is a large operator with two listings here — but
 * nothing Airbnb publishes to us carries a host's total. See issue #34.
 */
export const hostListingPortfolios = pgView('host_listing_portfolios', {
  hostId: bigint('host_id'),
  scrapeDate: day('scrape_date'),
  listingsActive: integer('listings_active'),
  listingsEverSeen: integer('listings_ever_seen'),
}).as(
  sql`WITH held AS (
    SELECT
        ${airbnbListingObservations.listingId},
        ${airbnbListingObservations.scrapeDate},
        -- A struct, so "read the page, no host" is not skipped over the way
        -- "page not read" is.
        last_value(
            CASE WHEN ${airbnbListingObservations.pageFetchOk}
                 THEN {'host_id': ${airbnbListingObservations.hostId}} END IGNORE NULLS
        ) OVER (PARTITION BY listing_id ORDER BY scrape_date).host_id AS host_id
    FROM ${airbnbListingObservations}
),
-- Completed runs, by latest_scrape_date's definition.
run_dates AS (
    SELECT ${airbnbListingObservations.scrapeDate} FROM ${airbnbListingObservations}
    UNION
    ${qb
      .select({ scrapeDate: airbnbScrapeRuns.scrapeDate })
      .from(airbnbScrapeRuns)
      .where(isNotNull(airbnbScrapeRuns.listingsSeen))}
),
-- Each listing live on each run date, held by whoever its latest observation
-- on or before that date names.
live AS (
    SELECT d.scrape_date, h.listing_id, h.host_id
    FROM run_dates d
    JOIN held h
      ON h.scrape_date BETWEEN d.scrape_date
        - INTERVAL ${sql.raw(String(RETIREMENT_GRACE_DAYS))} DAY AND d.scrape_date
    QUALIFY row_number() OVER (
        PARTITION BY d.scrape_date, h.listing_id ORDER BY h.scrape_date DESC
    ) = 1
),
live_counts AS (
    SELECT host_id, scrape_date, count(*) AS listings_active
    FROM live
    WHERE host_id IS NOT NULL
    GROUP BY host_id, scrape_date
),
first_held AS (
    SELECT host_id, listing_id, min(scrape_date) AS scrape_date
    FROM held
    WHERE host_id IS NOT NULL
    GROUP BY host_id, listing_id
),
newly_seen AS (
    SELECT host_id, scrape_date, count(*) AS listings_new
    FROM first_held
    GROUP BY host_id, scrape_date
),
panel AS (
    SELECT f.host_id, d.scrape_date
    FROM (SELECT host_id, min(scrape_date) AS since FROM first_held GROUP BY host_id) f
    JOIN run_dates d ON d.scrape_date >= f.since
)
SELECT
    p.host_id,
    p.scrape_date,
    coalesce(l.listings_active, 0)::INTEGER AS listings_active,
    sum(coalesce(n.listings_new, 0)) OVER (
        PARTITION BY p.host_id ORDER BY p.scrape_date
    )::INTEGER AS listings_ever_seen
FROM panel p
LEFT JOIN live_counts l USING (host_id, scrape_date)
LEFT JOIN newly_seen n USING (host_id, scrape_date)`,
);

/**
 * `listingsActive` plus the owning host's profile and portfolio as of the
 * latest run, so "is this Girdwood listing part of a large one?" needs no
 * join. The host columns are NULL when the host is unknown.
 */
export const listingsActiveWithHost = pgView('listings_active_with_host', {
  ...listingColumns,
  hostName: varchar('host_name'),
  hostYearsHosting: integer('host_years_hosting'),
  hostHostingStartedOn: day('host_hosting_started_on'),
  hostListingsActive: integer('host_listings_active'),
  hostListingsEverSeen: integer('host_listings_ever_seen'),
}).as(
  sql`${qb
    .select({
      ...columnsOf(listingsActive),
      hostName: sql`${hosts.name}`.as('host_name'),
      hostYearsHosting: sql`${hosts.yearsHosting}`.as('host_years_hosting'),
      hostHostingStartedOn: sql`${hosts.hostingStartedOn}`.as('host_hosting_started_on'),
      hostListingsActive: sql`${hostListingPortfolios.listingsActive}`.as('host_listings_active'),
      hostListingsEverSeen: sql`${hostListingPortfolios.listingsEverSeen}`.as('host_listings_ever_seen'),
    })
    .from(listingsActive)
    .leftJoin(
      hosts,
      and(eq(hosts.hostId, listingsActive.hostId), isNull(hosts.validTo)),
    )
    .leftJoin(
      hostListingPortfolios,
      and(
        eq(hostListingPortfolios.hostId, listingsActive.hostId),
        eq(
          hostListingPortfolios.scrapeDate,
          qb.select({ scrapeDate: latestScrapeDate.scrapeDate }).from(latestScrapeDate),
        ),
      ),
    )}`,
);

// --------------------------------------------------------------------------
// Municipal STR registry

/** The latest registry run that completed its writes. One row, one column. */
export const latestRegistryDate = pgView('latest_registry_date', {
  scrapeDate: day('scrape_date'),
}).as(
  sql`${qb
    .select({ scrapeDate: sql`max(${muniStrRegistryRuns.scrapeDate})`.as('scrape_date') })
    .from(muniStrRegistryRuns)
    .where(isNotNull(muniStrRegistryRuns.registrationsSeen))}`,
);

/** The most recent read of each CityView license page. */
export const licensePagesLatest = pgView('license_pages_latest', {
  cityviewLicenseId: integer('cityview_license_id'),
  scrapeDate: day('scrape_date'),
  licenseId: varchar('license_id'),
  businessName: varchar('business_name'),
  licenseType: varchar('license_type'),
  status: varchar('status'),
  description: varchar('description'),
  locations: structList<LicenseLocation>(LICENSE_LOCATIONS_TYPE)('locations'),
  issuances: structList<LicenseIssuance>(LICENSE_ISSUANCES_TYPE)('issuances'),
}).as(
  sql`SELECT * FROM ${muniLicensePageReads}
QUALIFY row_number() OVER (
    PARTITION BY ${muniLicensePageReads.cityviewLicenseId}
    ORDER BY ${muniLicensePageReads.scrapeDate} DESC
) = 1`,
);

/** CityView's own row id for a registration's license, read from its `status_url`. */
export const cityviewLicenseIdSql = (statusUrl: Column): SQL<number | null> =>
  sql`nullif(regexp_extract(${statusUrl}, '[?&]licenseId=(\\d+)', 1), '')::INTEGER`;

/** `registrations` and `registrationsActive` share these columns. */
const registrationColumns = {
  registrationId: varchar('registration_id'),
  licenseId: varchar('license_id'),
  cityviewLicenseId: integer('cityview_license_id'),
  status: varchar('status'),
  submittedDate: day('submitted_date'),
  issuedDate: day('issued_date'),
  expiresDate: day('expires_date'),
  businessName: varchar('business_name'),
  registeredAddress: varchar('registered_address'),
  communityCouncil: varchar('community_council'),
  parcelType: varchar('parcel_type'),
  geocodedAddress: varchar('geocoded_address'),
  geocodedLat: doublePrecision('geocoded_lat'),
  geocodedLng: doublePrecision('geocoded_lng'),
  statusUrl: varchar('status_url'),
  publishedAt: naiveTimestamp('published_at'),
  licenseReadDate: day('license_read_date'),
  licenseStatus: varchar('license_status'),
  licenseType: varchar('license_type'),
  licenseDescription: varchar('license_description'),
  licenseBusinessName: varchar('license_business_name'),
  licenseParcelIds: varcharList('license_parcel_ids'),
  licenseAddresses: varcharList('license_addresses'),
  parcelId: varchar('parcel_id'),
  licenseIssuances: structList<LicenseIssuance>(LICENSE_ISSUANCES_TYPE)('license_issuances'),
  airbnbListingsActive: integer('airbnb_listings_active'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  isActive: boolean('is_active'),
} as const;

/** When and how often each registration has been published. */
const registrationActivity = qb
  .$with(
    'activity',
    derived('activity', {
      registrationId: varchar('registration_id'),
      firstSeenDate: day('first_seen_date'),
      lastSeenDate: day('last_seen_date'),
    }),
  )
  .as(
    sql`${qb
      .select({
        registrationId: muniStrRegistrationObservations.registrationId,
        firstSeenDate: sql`min(${muniStrRegistrationObservations.scrapeDate})`.as(
          'first_seen_date',
        ),
        lastSeenDate: sql`max(${muniStrRegistrationObservations.scrapeDate})`.as('last_seen_date'),
      })
      .from(muniStrRegistrationObservations)
      .groupBy(muniStrRegistrationObservations.registrationId)}`,
  );

/** Each registration as the layer last published it, with its license id. */
const latestRegistration = qb
  .$with('latest', {
    ...getTableColumns(muniStrRegistrationObservations),
    ...derived('latest', { cityviewLicenseId: integer('cityview_license_id') }),
  })
  .as(
    sql`SELECT *, ${cityviewLicenseIdSql(muniStrRegistrationObservations.statusUrl)} AS cityview_license_id
    FROM ${muniStrRegistrationObservations}
    QUALIFY row_number() OVER (
        PARTITION BY ${muniStrRegistrationObservations.registrationId}
        ORDER BY ${muniStrRegistrationObservations.scrapeDate} DESC
    ) = 1`,
  );

/** Active Airbnb listings per registration id they cite. */
const citedByAirbnb = qb
  .$with(
    'airbnb',
    derived('airbnb', {
      registrationId: varchar('registration_id'),
      listings: integer('listings'),
    }),
  )
  .as(
    sql`${qb
      .select({
        registrationId: sql`${listingsActive.registrationId}`.as('registration_id'),
        listings: sql`count(*)::INTEGER`.as('listings'),
      })
      .from(listingsActive)
      .where(isNotNull(listingsActive.registrationId))
      .groupBy(listingsActive.registrationId)}`,
  );

/**
 * One row per registration ever published, with its latest published fields
 * and latest license page. A registration is active if it was in the latest
 * registry run's layer, which lists only active registrations.
 */
export const registrations = pgView('registrations', registrationColumns).as(
  sql`${qb
    .with(registrationActivity, latestRegistration, citedByAirbnb)
    .select({
      registrationId: latestRegistration.registrationId,
      licenseId: latestRegistration.licenseId,
      cityviewLicenseId: latestRegistration.cityviewLicenseId,
      status: latestRegistration.status,
      submittedDate: latestRegistration.submittedDate,
      issuedDate: latestRegistration.issuedDate,
      expiresDate: latestRegistration.expiresDate,
      businessName: sql`nullif(${latestRegistration.businessName}, 'None')`.as('business_name'),
      registeredAddress: latestRegistration.registeredAddress,
      communityCouncil: latestRegistration.communityCouncil,
      parcelType: latestRegistration.parcelType,
      geocodedAddress: latestRegistration.geocodedAddress,
      // NULL where the geocoder found no match, instead of its placeholder coordinate.
      geocodedLat:
        sql`CASE WHEN ${latestRegistration.geocodedAddress} IS DISTINCT FROM ${NO_MATCH_GEOCODED_ADDRESS}
             THEN ${latestRegistration.geocodedLat} END`.as('geocoded_lat'),
      geocodedLng:
        sql`CASE WHEN ${latestRegistration.geocodedAddress} IS DISTINCT FROM ${NO_MATCH_GEOCODED_ADDRESS}
             THEN ${latestRegistration.geocodedLng} END`.as('geocoded_lng'),
      statusUrl: latestRegistration.statusUrl,
      publishedAt: latestRegistration.publishedAt,
      licenseReadDate: sql`${licensePagesLatest.scrapeDate}`.as('license_read_date'),
      licenseStatus: sql`${licensePagesLatest.status}`.as('license_status'),
      licenseType: licensePagesLatest.licenseType,
      licenseDescription: sql`${licensePagesLatest.description}`.as('license_description'),
      licenseBusinessName: sql`${licensePagesLatest.businessName}`.as('license_business_name'),
      // Parcel ids linked to property records. A parcel id typed as text has
      // no label and is not included (license 13990).
      licenseParcelIds:
        sql`[l.value FOR l IN ${licensePagesLatest.locations} IF l.label = 'Property']`.as(
          'license_parcel_ids',
        ),
      licenseAddresses:
        sql`[l.value FOR l IN ${licensePagesLatest.locations} IF l.label = 'Address']`.as(
          'license_addresses',
        ),
      // The parcel id when the license lists exactly one; join to
      // anchorage-property's parcels on it.
      parcelId: sql`CASE WHEN len([l FOR l IN ${licensePagesLatest.locations} IF l.label = 'Property']) = 1
           THEN [l.value FOR l IN ${licensePagesLatest.locations} IF l.label = 'Property'][1] END`.as(
        'parcel_id',
      ),
      licenseIssuances: sql`${licensePagesLatest.issuances}`.as('license_issuances'),
      airbnbListingsActive: sql`coalesce(${citedByAirbnb.listings}, 0)`.as(
        'airbnb_listings_active',
      ),
      firstSeenDate: registrationActivity.firstSeenDate,
      lastSeenDate: registrationActivity.lastSeenDate,
      isActive: sql`${registrationActivity.lastSeenDate} = (${qb
        .select({ scrapeDate: latestRegistryDate.scrapeDate })
        .from(latestRegistryDate)})`.as('is_active'),
    })
    .from(latestRegistration)
    .innerJoin(
      registrationActivity,
      eq(registrationActivity.registrationId, latestRegistration.registrationId),
    )
    .leftJoin(licensePagesLatest, eq(licensePagesLatest.cityviewLicenseId, latestRegistration.cityviewLicenseId))
    .leftJoin(
      citedByAirbnb,
      eq(citedByAirbnb.registrationId, latestRegistration.registrationId),
    )}`,
);

/** The registrations in the latest registry run: the Muni publishes only active ones. */
export const registrationsActive = pgView('registrations_active', registrationColumns).as(
  sql`${qb
    .select(columnsOf(registrations))
    .from(registrations)
    .where(eq(registrations.isActive, true))}`,
);

/**
 * `listingsActive` plus the registration its page cites. The registration
 * columns are NULL when the listing shows no number or the number is not in
 * the registry, which includes numbers issued since the layer's last publish.
 */
export const listingsActiveWithRegistration = pgView('listings_active_with_registration', {
  ...listingColumns,
  registrationFound: boolean('registration_found'),
  registrationIsActive: boolean('registration_is_active'),
  registrationBusinessName: varchar('registration_business_name'),
  registrationAddress: varchar('registration_address'),
  registrationParcelId: varchar('registration_parcel_id'),
  registrationParcelType: varchar('registration_parcel_type'),
  registrationCommunityCouncil: varchar('registration_community_council'),
  registrationIssuedDate: day('registration_issued_date'),
  registrationExpiresDate: day('registration_expires_date'),
  registrationLicenseDescription: varchar('registration_license_description'),
  registrationAirbnbListingsActive: integer('registration_airbnb_listings_active'),
}).as(
  sql`${qb
    .select({
      ...columnsOf(listingsActive),
      registrationFound: sql`${registrations.registrationId} IS NOT NULL`.as(
        'registration_found',
      ),
      registrationIsActive: sql`${registrations.isActive}`.as('registration_is_active'),
      registrationBusinessName: sql`${registrations.businessName}`.as(
        'registration_business_name',
      ),
      registrationAddress: sql`${registrations.registeredAddress}`.as('registration_address'),
      registrationParcelId: sql`${registrations.parcelId}`.as('registration_parcel_id'),
      registrationParcelType: sql`${registrations.parcelType}`.as('registration_parcel_type'),
      registrationCommunityCouncil: sql`${registrations.communityCouncil}`.as(
        'registration_community_council',
      ),
      registrationIssuedDate: sql`${registrations.issuedDate}`.as('registration_issued_date'),
      registrationExpiresDate: sql`${registrations.expiresDate}`.as('registration_expires_date'),
      registrationLicenseDescription: sql`${registrations.licenseDescription}`.as(
        'registration_license_description',
      ),
      registrationAirbnbListingsActive: sql`${registrations.airbnbListingsActive}`.as(
        'registration_airbnb_listings_active',
      ),
    })
    .from(listingsActive)
    .leftJoin(
      registrations,
      eq(registrations.registrationId, listingsActive.registrationId),
    )}`,
);

/**
 * Every view, in the order `connect` creates them: each one reads only the
 * tables and the views above it.
 */
export const VIEWS = [
  latestScrapeDate,
  listingActivity,
  listingVersions,
  listings,
  listingsActive,
  listingPhotosCurrent,
  calendarCurrent,
  hostActivity,
  hostVersions,
  hosts,
  hostListingPortfolios,
  listingsActiveWithHost,
  latestRegistryDate,
  licensePagesLatest,
  registrations,
  registrationsActive,
  listingsActiveWithRegistration,
] as const;
