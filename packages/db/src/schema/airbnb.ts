/**
 * Airbnb, as the daily scrape reads it.
 *
 * - `airbnb_listing_observations`: append-only, one row per (listing, scrape
 *   date) with everything read that day from search and the listing page.
 *   The only stored facts about a listing.
 * - `airbnb_calendar_status`: SCD2 on (listing_id, night_date). A night that
 *   leaves Airbnb's ~12-month calendar window is no longer observed, so its
 *   last value stays as the realized available / not-available state.
 * - `airbnb_listing_first_reviews`: one row per listing whose earliest review
 *   date has been resolved. Keyed by `listing_id` rather than a column on
 *   `airbnb_listing_observations`, because it is resolved once: as a daily
 *   column it would be NULL on every row but one per listing.
 * - `airbnb_listing_photos`: each listing's photo gallery, one row per
 *   distinct set, written only when the set differs from the listing's
 *   previous one.
 * - `airbnb_host_observations`: append-only, one row per (host, scrape date)
 *   for every host of a listing observed that day: the host card from
 *   the listing page.
 * - `airbnb_scrape_runs`: one row per daily run.
 *
 * `airbnb_calendar_status` is stored change-only because a daily snapshot
 * would be ~950k rows/day, and `airbnb_listing_photos` because a gallery of
 * ~20 URLs on every daily row would grow the published database by hundreds
 * of MB a year. Listings are ~2600 rows/day, so they are stored daily and
 * `listings` is a view (see `../views/airbnb.ts`).
 *
 * Listing-page fields share the row with the search fields so that
 * `location_is_exact` is readable next to `location_lat`/`location_lng`
 * without a join. A day whose page fetch failed stores `page_fetch_ok =
 * false` and NULLs; the views carry the last successful read forward.
 */

import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/pg-core';

import { day, id, naiveTimestamp, varcharList } from './columns.ts';

export const airbnbListingObservations = pgTable(
  'airbnb_listing_observations',
  {
    listingId: id('listing_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),

    // From the search response; present for every observed listing.
    name: varchar('name'),
    propertyTitle: varchar('property_title'),
    locationLat: doublePrecision('location_lat'),
    locationLng: doublePrecision('location_lng'),
    url: varchar('url'),
    badges: varcharList('badges'),

    // These change most days, so they are not part of the version key.
    ratingValue: doublePrecision('rating_value'),
    reviewCount: integer('review_count'),
    priceHintPerNight: doublePrecision('price_hint_per_night'),
    priceQualifier: varchar('price_qualifier'),

    // From the listing's own page, a separate request. `page_fetch_ok`
    // distinguishes "read the page, no registration id" from "page not read";
    // the columns below it are NULL when it is false.
    pageFetchOk: boolean('page_fetch_ok').notNull(),
    locationIsExact: boolean('location_is_exact'),
    locationExactAddress: varchar('location_exact_address'),
    locationSubtitle: varchar('location_subtitle'),
    locationVerified: boolean('location_verified'),
    registrationId: varchar('registration_id'),
    // The primary host's Airbnb user id (airbnb.com/users/show/<host_id>).
    hostId: id('host_id'),
    // Airbnb's text, verbatim: 'Entire home/apt', 'Private room', ...
    listingType: varchar('listing_type'),
    guestCapacity: integer('guest_capacity'),
    // Airbnb's bedCount; a bunk bed counts as 2.
    beds: integer('beds'),
    // Overview lines, verbatim: '2 bedrooms', 'Studio'; '1.5 baths',
    // 'Shared bathroom'.
    bedrooms: varchar('bedrooms'),
    bathrooms: varchar('bathrooms'),

    // The price of one bookable stay: quote_total for quote_nights nights
    // from quote_check_in. NULL when no stay was quoted. quote_label is
    // Airbnb's text ('$241 for 2 nights, originally $269', or why there is no
    // price); quote_breakdown its price-detail lines.
    quoteCheckIn: day('quote_check_in'),
    quoteNights: integer('quote_nights'),
    quoteTotal: doublePrecision('quote_total'),
    quoteLabel: varchar('quote_label'),
    quoteBreakdown: varcharList('quote_breakdown'),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.scrapeDate] })],
);

export const airbnbCalendarStatus = pgTable('airbnb_calendar_status', {
  listingId: id('listing_id').notNull(),
  nightDate: day('night_date').notNull(),
  available: boolean('available').notNull(),
  minNights: integer('min_nights'),
  statusHash: varchar('status_hash').notNull(),
  validFrom: day('valid_from').notNull(),
  validTo: day('valid_to'),
  isCurrent: boolean('is_current').notNull(),
});

/**
 * The first URL is the cover photo. A set is current from valid_from until
 * the listing's next row.
 */
export const airbnbListingPhotos = pgTable(
  'airbnb_listing_photos',
  {
    listingId: id('listing_id').notNull(),
    validFrom: day('valid_from').notNull(),
    photoUrls: varcharList('photo_urls').notNull(),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.validFrom] })],
);

/** Pass counts are NULL on a failed run, which wrote nothing else. */
export const airbnbScrapeRuns = pgTable('airbnb_scrape_runs', {
  scrapeDate: day('scrape_date').notNull(),
  runStartedAt: naiveTimestamp('run_started_at').notNull(),
  runFinishedAt: naiveTimestamp('run_finished_at'),
  listingsSeen: integer('listings_seen'),
  listingsNew: integer('listings_new'),
  listingsChanged: integer('listings_changed'),
  listingsRetired: integer('listings_retired'),
  calendarFetchAttempted: integer('calendar_fetch_attempted'),
  calendarFetchFailed: integer('calendar_fetch_failed'),
  calendarNightsChanged: integer('calendar_nights_changed'),
  pageFetchAttempted: integer('page_fetch_attempted'),
  pageFetchFailed: integer('page_fetch_failed'),
  errorSummary: varchar('error_summary'),
  // After error_summary, matching the published database's column order.
  firstReviewFetchAttempted: integer('first_review_fetch_attempted'),
  firstReviewFetchFailed: integer('first_review_fetch_failed'),
  quoteFetchAttempted: integer('quote_fetch_attempted'),
  quoteFetchFailed: integer('quote_fetch_failed'),
  // Distinct hosts of a listing observed this run, and how many of them
  // had no host card read.
  hostProfileAttempted: integer('host_profile_attempted'),
  hostProfileFailed: integer('host_profile_failed'),
});

/**
 * A row means the listing's reviews were read; a missing row means they have
 * not been yet. Failed fetches write no row and are retried next run. Stores
 * the date only: no review text or reviewer.
 */
export const airbnbListingFirstReviews = pgTable('airbnb_listing_first_reviews', {
  listingId: id('listing_id').primaryKey(),
  // UTC date of the listing's oldest review; NULL if it had no reviews.
  firstReviewDate: day('first_review_date'),
  // The scrape date of the run that read the reviews.
  resolvedDate: day('resolved_date').notNull(),
});

/**
 * A host gets a row on every day one of their listings was observed,
 * including a day that listing's page failed, when the owner is known only
 * from the carried-forward host_id. `profile_read_ok` says whether any of the
 * host's listing pages yielded their card that day; the columns below it are
 * NULL when it is false.
 */
export const airbnbHostObservations = pgTable(
  'airbnb_host_observations',
  {
    hostId: id('host_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),
    profileReadOk: boolean('profile_read_ok').notNull(),
    // A first name or a business name. Airbnb shows no surnames.
    name: varchar('name'),
    // The bio as the host wrote it. NULL on a read row means none.
    about: varchar('about'),
    // Airbnb's `timeAsHost` as of scrape_date. Airbnb publishes no start
    // date; `host_activity` derives one.
    timeAsHostYears: integer('time_as_host_years'),
    timeAsHostMonths: integer('time_as_host_months'),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.scrapeDate] })],
);
