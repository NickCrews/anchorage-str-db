/**
 * The tables, as Drizzle definitions. `drizzle-kit generate` turns a change
 * here into a migration in `../drizzle`, which `connect` applies.
 *
 * Each table name starts with its source: `airbnb_`, `muni_str_` for the
 * Municipal Clerk's STR registration layer, `muni_license_` for the Muni's
 * CityView license pages, `muni_address_` for the Muni's geocoder, and
 * `property_` for anchorage-property's parcel database. Views
 * are named for what they derive (`listings`, `registrations`) and carry no
 * prefix.
 *
 * Airbnb:
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
 *   distinct set, written only when its photos or cover photo differ from the
 *   listing's previous set.
 * - `airbnb_host_observations`: append-only, one row per (host, scrape date)
 *   for every host of a listing observed that day: the host card from
 *   the listing page.
 * - `airbnb_scrape_runs`: one row per Airbnb scrape.
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
 * - `muni_str_registry_runs`: one row per registry run, which read the
 *   registration layer and then a batch of license pages.
 *
 * The layer answers only with a token, so these two tables are an archive
 * that nothing writes. `registrations` takes the layer's geocoding from it
 * for a license whose own address has no match.
 *
 * - `muni_license_page_reads`: one row per visible CityView license page
 *   read, of any license type. Pages are read on a rolling schedule, not
 *   every run.
 * - `muni_license_hidden_reads`: one row per read of a hidden license id.
 * - `muni_license_scrape_runs`: one row per license scrape.
 *
 * Together the two read tables are the scrape's state: which ids have been
 * read, when, and what they were.
 *
 * - `muni_address_geocodes`: one row per license address the Muni's geocoder
 *   was asked about, with its community council. The license scrape writes it
 *   after its page reads, and `licenses` joins it on the address.
 *
 * anchorage-property, which archives the Muni's parcels with their history:
 *
 * - `property_parcels`: one row per parcel, the current state of
 *   anchorage-property's `parcels_current`, replaced whole by each parcel
 *   scrape. History stays in anchorage-property; `licenses` and
 *   `registrations` join it on `parcel_id`.
 * - `property_parcel_scrape_runs`: one row per parcel scrape.
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
 * The first URL is the cover photo. A new row means the listing's photos or
 * its cover photo changed; the rest of the order is as first stored. A set is
 * current from valid_from until the listing's next row.
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
    // 'LC260500349', the license's own id. The license page labels it
    // "Licensee Number" and the layer calls it ApplicationNumber, but it
    // identifies the license, not the licensee: a business holding four
    // licenses has four. One per registration, like cityview_license_id.
    licenseId: varchar('license_id'),
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
    // The CityView license page; the licenseId in its URL is
    // cityview_license_id, which keys muni_license_page_reads.
    statusUrl: varchar('status_url'),
    // The council containing the geocoded coordinate; NULL exactly when geocoding
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
    // 'Incomplete address provided. No Match.' and a placeholder coordinate.
    geocodedAddress: varchar('geocoded_address'),
    // The geocoded coordinate, not a position the registrant gave.
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

export interface LicenseSubmittal {
  name: string | null;
  type: string | null;
  date: string | null;
  status: string | null;
}

/** A failed read writes no row. Text is as the page shows it. */
export const muniLicensePageReads = pgTable(
  'muni_license_page_reads',
  {
    cityviewLicenseId: integer('cityview_license_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),
    licenseId: varchar('license_id').notNull(),
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
    // In page order; an empty list when the page says there are none. NULL on
    // the reads made by the registry run, which did not store them.
    submittals: structList<LicenseSubmittal>(
      'submittals',
      'STRUCT(name VARCHAR, type VARCHAR, date DATE, status VARCHAR)[]',
    ),
  },
  (t) => [primaryKey({ columns: [t.cityviewLicenseId, t.scrapeDate] })],
);

/**
 * A read of a hidden license id: the portal's "Invalid License" page, which
 * shows nothing about the license. A failed read writes no row.
 */
export const muniLicenseHiddenReads = pgTable(
  'muni_license_hidden_reads',
  {
    cityviewLicenseId: integer('cityview_license_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),
  },
  (t) => [primaryKey({ columns: [t.cityviewLicenseId, t.scrapeDate] })],
);

/** Counts are NULL on a failed scrape, which wrote nothing else. */
export const muniLicenseScrapeRuns = pgTable('muni_license_scrape_runs', {
  scrapeDate: day('scrape_date').notNull(),
  runStartedAt: naiveTimestamp('run_started_at').notNull(),
  runFinishedAt: naiveTimestamp('run_finished_at'),
  // The highest id on the License Locator's first page: the newest visible license.
  newestCityviewLicenseId: integer('newest_cityview_license_id'),
  // Ids whose page the scrape tried to read; the next three add up to it.
  pagesAttempted: integer('pages_attempted'),
  // Visible pages read, stored in muni_license_page_reads.
  pagesRead: integer('pages_read'),
  // Hidden license ids read, stored in muni_license_hidden_reads.
  hiddenRead: integer('hidden_read'),
  pagesFailed: integer('pages_failed'),
  // Visible pages of licenses with no visible read before this scrape date.
  licensesNew: integer('licenses_new'),
  // Visible pages whose page or issuance statuses differ from the license's
  // previous visible read.
  licensesStatusChanged: integer('licenses_status_changed'),
  errorSummary: varchar('error_summary'),
});

/** Counts are NULL on a failed run, which wrote nothing else. Not written. */
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

// --------------------------------------------------------------------------
// Muni GIS

/**
 * One row per address, as a license page shows it, sent to the Muni's
 * geocoder (`MOA_Multirole_Locator`). A row with no match is kept, so the
 * address is not asked about again until the license scrape's retry interval
 * passes; the next answer replaces the row. A failed request writes no row.
 */
export const muniAddressGeocodes = pgTable('muni_address_geocodes', {
  // Verbatim from the license page, so it joins to licenses.address.
  address: varchar('address').primaryKey(),
  // The scrape date of the license scrape that asked.
  geocodedDate: day('geocoded_date').notNull(),
  // The geocoder's address for the match, in its own style:
  // '525 W 3rd Ave, #501, Anchorage, AK, 99501'. NULL when it found no
  // candidate that places the address itself.
  matchedAddress: varchar('matched_address'),
  // The match's coordinate; NULL with matched_address.
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  // The council containing the coordinate when it was geocoded; NULL with
  // matched_address, or when no council contains it.
  communityCouncil: varchar('community_council'),
  // The geocoder's best candidate, kept when it is not a match: score 90 to
  // 100, and its Addr_type ('PointAddress', 'Subaddress', or 'StreetName' for
  // the street alone). NULL when it had no candidate.
  score: doublePrecision('score'),
  matchType: varchar('match_type'),
});

// --------------------------------------------------------------------------
// anchorage-property

/**
 * One row per parcel: anchorage-property's `parcels_current` as of the last
 * parcel scrape, which deletes every row and inserts the snapshot. Values
 * are as anchorage-property publishes them.
 */
export const propertyParcels = pgTable('property_parcels', {
  // The Muni's 11-digit Parcel_ID, '07606227000': the parcel id a license
  // page's Property location holds.
  parcelId: varchar('parcel_id').primaryKey(),
  // The parcel record's site address: '257 ECHO RIDGE DR'.
  parcelAddress: varchar('parcel_address'),
  // The appraisal grouping, upper case: 'RESIDENTIAL', 'CONDO', 'VACANT
  // LAND', 'COMMERCIAL', 'APARTMENT', ... Not the archived registration
  // layer's 'Residential'/'Commercial'.
  propertyType: varchar('property_type'),
  totalLivingUnits: integer('total_living_units'),
  // Finer than property_type: 'Residential 1 Family', 'Condo (Fee simple)'.
  landUse: varchar('land_use'),
  // The zoning district code: 'R1', 'R2M', 'GR2'.
  zoningDistrict: varchar('zoning_district'),
  // The centroid of the parcel's polygon, EPSG:4326.
  centroidLat: doublePrecision('centroid_lat'),
  centroidLon: doublePrecision('centroid_lon'),
  // When anchorage-property last saw the parcel change, naive UTC.
  validFrom: naiveTimestamp('valid_from'),
  // The scrape_date of the parcel scrape that wrote the row.
  scrapeDate: day('scrape_date').notNull(),
  // The owner of record and their mailing address, as the Muni publishes
  // them: 'SMITH JOHN & JANE', '1234 MAIN ST', 'ANCHORAGE', 'AK', '99501'.
  // The mailing address is where tax notices go, not necessarily where the
  // owner lives.
  ownerName: varchar('owner_name'),
  ownerAddress: varchar('owner_address'),
  ownerCity: varchar('owner_city'),
  ownerState: varchar('owner_state'),
  ownerZip: varchar('owner_zip'),
  // Every exemption on the parcel, comma-separated: 'OWNERS PRIMARY
  // RESIDENCE, SENIOR CITIZEN'. Empty or NULL when there is none.
  exemptionTypesAll: varchar('exemption_types_all'),
  appraisedTotalValue: doublePrecision('appraised_total_value'),
});

/** Counts are NULL on a failed scrape, which left property_parcels as it was. */
export const propertyParcelScrapeRuns = pgTable('property_parcel_scrape_runs', {
  scrapeDate: day('scrape_date').notNull(),
  runStartedAt: naiveTimestamp('run_started_at').notNull(),
  runFinishedAt: naiveTimestamp('run_finished_at'),
  // Rows written to property_parcels.
  parcelsWritten: integer('parcels_written'),
  // The run_id of anchorage-property's newest successful ingest run in the
  // source, '2026-11-13-d1a8fba8': which day's parcels were copied.
  sourceIngestRun: varchar('source_ingest_run'),
  errorSummary: varchar('error_summary'),
});
