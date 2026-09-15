/**
 * The tables, as Drizzle definitions. `drizzle-kit generate` turns a change
 * here into a migration in `../drizzle`, which `connect` applies.
 *
 * Each table name starts with its source: `airbnb_`, `muni_str_` for the
 * Municipal Clerk's STR registration layer, and `muni_license_` for the
 * Muni's CityView license pages. Views are named for what they derive
 * (`listings`, `registrations`) and carry no prefix.
 *
 * Airbnb:
 *
 * - `airbnb_listing_observations`: append-only, one row per (listing, scrape
 *   date) with everything read that day from search and the listing page.
 *   The only stored facts about a listing.
 * - `airbnb_calendar_status`: SCD2 on (listing_id, night_date). A night that
 *   leaves Airbnb's ~12-month calendar window is no longer observed, so its
 *   last value stays as the realized booked/available state.
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
 * `listings` is a view (see `views.ts`).
 *
 * Listing-page fields share the row with the search fields so that
 * `location_is_exact` is readable next to `location_lat`/`location_lng`
 * without a join. A day whose page fetch failed stores `page_fetch_ok =
 * false` and NULLs; the views carry the last successful read forward.
 *
 * The Municipality, stored as published:
 *
 * - `muni_str_registration_observations`: append-only, one row per
 *   (registration, registry run) from the Clerk's ArcGIS layer. The layer
 *   lists only active registrations, so a registration's absence from a run
 *   is the only record that it lapsed.
 * - `muni_license_page_reads`: one row per CityView license page read. Pages
 *   are read on a rolling schedule, not every run.
 * - `muni_str_registry_runs`: one row per registry run, which reads the
 *   registration layer and then a batch of license pages.
 *
 * Registrations are stored as a daily snapshot rather than change-only:
 * ~2500 rows compress to ~50 KB a day, and a snapshot per run gives exact
 * first- and last-seen dates without interval logic.
 *
 * Column order is the physical order: `appendRows` writes values in the
 * order the columns are declared here, and `connect` rejects a database
 * whose tables differ. Add a column at the end of its table.
 */

import { duckDbList } from '@duckdbfan/drizzle-duckdb';
import {
  bigint,
  boolean,
  customType,
  date,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/** A DuckDB `DATE`, read and written as `YYYY-MM-DD`. */
const day = (name: string) => date(name, { mode: 'string' });

/** A naive UTC DuckDB `TIMESTAMP`, read and written as `YYYY-MM-DD HH:MM:SS`. */
const naiveTimestamp = (name: string) => timestamp(name, { mode: 'string' });

const id = (name: string) => bigint(name, { mode: 'bigint' });

const varcharList = (name: string) => duckDbList<string>(name, 'VARCHAR');

/** A list of structs; `sqlType` is the full DuckDB type, e.g. `STRUCT(a VARCHAR)[]`. */
function structList<T>(name: string, sqlType: string) {
  return customType<{ data: T[] }>({ dataType: () => sqlType })(name);
}

// --------------------------------------------------------------------------
// Airbnb

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
    // distinguishes "read the page, no STR number" from "page not read";
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
    roomType: varchar('room_type'),
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

// --------------------------------------------------------------------------
// Municipal STR registry

export const muniStrRegistrationObservations = pgTable(
  'muni_str_registration_observations',
  {
    // 'STR20260309'; Airbnb listings show it as registration_id.
    registrationId: varchar('registration_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),
    // 'LC260500349', the license page's Licensee Number.
    licenseeId: varchar('licensee_id'),
    submittedDate: day('submitted_date'),
    issuedDate: day('issued_date'),
    expiresDate: day('expires_date'),
    // The address on the license. When the license is tied to a Muni property
    // record, this is that record's address in the Muni's parcel-address
    // style ('7730 MAYFAIR DR, Unit:APT 1, ANCHORAGE, AK 99502', or just
    // '311 MELODY PL' when the record has no city); otherwise it is the text
    // the registrant typed ('525 w 3rd Ave #501, anchorage AK 99501'). See
    // muni_license_page_reads.locations for which.
    registeredAddress: varchar('registered_address'),
    // The string 'None' when the registrant gave no business name.
    businessName: varchar('business_name'),
    status: varchar('status'),
    // The CityView license page; its licenseId keys muni_license_page_reads.
    statusUrl: varchar('status_url'),
    // The council containing the geocoded point; NULL exactly when geocoding
    // found no match.
    communityCouncil: varchar('community_council'),
    // 'Residential' or 'Commercial'. Can be NULL even when the license names
    // a parcel and the address geocoded (7821 MAYFAIR DR, Unit:APT C).
    parcelType: varchar('parcel_type'),
    // The Muni geocoder's (MOA_Multirole_Locator) reading of
    // registered_address, in its own style: '7821 Mayfair Dr, Apartment C,
    // Anchorage, Alaska, 99502'.
    // It rewrites typed text too ('#501' becomes 'Apartment 501', 'ROOM 4' is
    // dropped). An address with no city or zip gets
    // 'Incomplete address provided. No Match.' and a placeholder point.
    geocodedAddress: varchar('geocoded_address'),
    // The geocoded point, not a position the registrant gave.
    geocodedLat: doublePrecision('geocoded_lat'),
    geocodedLng: doublePrecision('geocoded_lng'),
    // The layer's PUBDATE, naive UTC.
    publishedAt: naiveTimestamp('published_at'),
  },
  (t) => [primaryKey({ columns: [t.registrationId, t.scrapeDate] })],
);

export interface LicenseLocation {
  label: string | null;
  value: string | null;
  link: string | null;
}

export interface LicenseIssuance {
  type: string | null;
  issued_date: string | null;
  expires_date: string | null;
  status: string | null;
  number: string | null;
}

/** A failed read writes no row. Text is as the page shows it. */
export const muniLicensePageReads = pgTable(
  'muni_license_page_reads',
  {
    licenseId: integer('license_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),
    licenseeId: varchar('licensee_id').notNull(),
    businessName: varchar('business_name'),
    // 'Short-Term Rentals'.
    licenseType: varchar('license_type'),
    status: varchar('status'),
    // The licensee's own description of the business.
    description: varchar('description'),
    // In page order. A value with a link is from the Muni's property records,
    // and the link is the portal's property search for it: label 'Property'
    // holds a parcel id, 'Address' the record's address. A value without a
    // link is text the registrant typed that matched no record, and usually
    // has no label. The label can be the portal's own lookup error
    // (license 13966).
    locations: structList<LicenseLocation>(
      'locations',
      'STRUCT(label VARCHAR, value VARCHAR, link VARCHAR)[]',
    ).notNull(),
    issuances: structList<LicenseIssuance>(
      'issuances',
      'STRUCT(type VARCHAR, issued_date DATE, expires_date DATE, status VARCHAR, number VARCHAR)[]',
    ).notNull(),
  },
  (t) => [primaryKey({ columns: [t.licenseId, t.scrapeDate] })],
);

/** Counts are NULL on a failed run, which wrote nothing else. */
export const muniStrRegistryRuns = pgTable('muni_str_registry_runs', {
  scrapeDate: day('scrape_date').notNull(),
  runStartedAt: naiveTimestamp('run_started_at').notNull(),
  runFinishedAt: naiveTimestamp('run_finished_at'),
  // The registration layer's editingInfo.dataLastEditDate, naive UTC.
  layerDataEditedAt: naiveTimestamp('layer_data_edited_at'),
  registrationsSeen: integer('registrations_seen'),
  registrationsNew: integer('registrations_new'),
  // In the previous run's layer but not this one's.
  registrationsLapsed: integer('registrations_lapsed'),
  licensePageAttempted: integer('license_page_attempted'),
  licensePageFailed: integer('license_page_failed'),
  errorSummary: varchar('error_summary'),
});
