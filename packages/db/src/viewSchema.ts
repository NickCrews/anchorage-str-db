/**
 * The views of `views.ts`, as Drizzle definitions: what `connect` creates,
 * declared so that a reader can name a view's columns and their types instead
 * of writing them out again.
 *
 * `views.ts` holds the SQL, which is what actually creates them. This file
 * only describes the result, and cannot drift from it: `connect` compares
 * every declaration here against the view DuckDB built, column for column, and
 * refuses the database if they differ. A view that gains, loses or retypes a
 * column has to be re-declared here in the same order.
 *
 * Every column is nullable. DuckDB reports no nullability for a view, so a
 * `notNull()` here would be an unchecked claim, and most of these columns
 * really can be NULL: a listing whose page was never read has no `room_type`,
 * a registration the geocoder could not place has no `geocoded_lat`.
 *
 * `.existing()` says the database already has the view, which makes every
 * declaration here a description and never a definition. A view Drizzle
 * defines is one it can render — a `select()` in the Postgres dialect — and
 * none of these are: they are DuckDB SQL (`SELECT * EXCLUDE`, `* REPLACE`,
 * `QUALIFY`, struct version keys, `to_months`) that `connect` recreates in
 * dependency order on every open, which is what lets a change to `views.ts`
 * land without a migration. Handing that text to `.as()` instead would move
 * the script into this file without making any of it checkable, and the
 * column list below would still have to be written by hand: what the columns
 * are is the one thing raw SQL cannot tell Drizzle.
 *
 * So the declarations carry no SQL of their own, and importing this file
 * costs nothing at runtime and reaches no driver: the viewer builds its
 * queries from the same objects the scraper's checks do. See the README for
 * which modules are safe to import in a browser.
 */

import { boolean, doublePrecision, integer, pgView, varchar } from 'drizzle-orm/pg-core';

import { bigint, day, hugeint, naiveTimestamp, structList, varcharList } from './columns.ts';
import {
  LICENSE_ISSUANCES_TYPE,
  LICENSE_LOCATIONS_TYPE,
  type LicenseIssuance,
  type LicenseLocation,
} from './schema.ts';

// --------------------------------------------------------------------------
// Airbnb

/** The date retirement is measured from. One row, one column. */
export const latestScrapeDate = pgView('latest_scrape_date', {
  scrapeDate: day('scrape_date'),
}).existing();

/** Per listing: first and last seen, last successful page read, and whether current. */
export const listingActivity = pgView('listing_activity', {
  listingId: bigint('listing_id'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  pageSeenDate: day('page_seen_date'),
  isCurrent: boolean('is_current'),
}).existing();

/** One row per listing version; see `listings` for the dimension to read. */
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
  strRegistrationId: varchar('str_registration_id'),
  hostId: bigint('host_id'),
  roomType: varchar('room_type'),
  guestCapacity: integer('guest_capacity'),
  beds: integer('beds'),
  bedrooms: varchar('bedrooms'),
  bathrooms: varchar('bathrooms'),
  validTo: day('valid_to'),
}).existing();

/**
 * `listings` and everything built on it start from these columns, in this
 * order, because each of those views is `SELECT l.*` with columns appended.
 */
const listingColumns = {
  listingId: bigint('listing_id'),
  name: varchar('name'),
  propertyTitle: varchar('property_title'),
  roomType: varchar('room_type'),
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
  strRegistrationId: varchar('str_registration_id'),
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
  isCurrent: boolean('is_current'),
} as const;

/** Every listing version ever observed: the dimension downstream queries read. */
export const listings = pgView('listings', listingColumns).existing();

/** `listings` filtered to the current version of a listing still in search. */
export const listingsCurrent = pgView('listings_current', listingColumns).existing();

/** Each listing's most recent photo set; `photoUrls[1]` is the cover photo. */
export const listingPhotosCurrent = pgView('listing_photos_current', {
  listingId: bigint('listing_id'),
  photoUrls: varcharList('photo_urls'),
  photoCount: integer('photo_count'),
  photosValidFrom: day('photos_valid_from'),
}).existing();

/** Current calendar rows, minus the future nights of retired listings. */
export const calendarCurrent = pgView('calendar_current', {
  listingId: bigint('listing_id'),
  nightDate: day('night_date'),
  available: boolean('available'),
  minNights: integer('min_nights'),
  statusHash: varchar('status_hash'),
  validFrom: day('valid_from'),
  validTo: day('valid_to'),
  isCurrent: boolean('is_current'),
}).existing();

/** Per host: first and last seen, last card read, tenure, and whether current. */
export const hostActivity = pgView('host_activity', {
  hostId: bigint('host_id'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  profileSeenDate: day('profile_seen_date'),
  hostingStartedOn: day('hosting_started_on'),
  hostingStartSpreadDays: integer('hosting_start_spread_days'),
  yearsHosting: integer('years_hosting'),
  isCurrent: boolean('is_current'),
}).existing();

/** One row per host version; see `hosts` for the dimension to read. */
export const hostVersions = pgView('host_versions', {
  hostId: bigint('host_id'),
  versionNo: hugeint('version_no'),
  validFrom: day('valid_from'),
  versionLastSeenDate: day('version_last_seen_date'),
  name: varchar('name'),
  about: varchar('about'),
  validTo: day('valid_to'),
}).existing();

/** The host dimension. Join to `listings` on `hostId`. */
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
  isCurrent: boolean('is_current'),
}).existing();

/**
 * Listings per host per completed run date. Counts only, and only listings in
 * the Anchorage search area: where an owner ends and an operator begins is
 * drawn downstream.
 */
export const hostPortfolios = pgView('host_portfolios', {
  hostId: bigint('host_id'),
  scrapeDate: day('scrape_date'),
  listingsLive: integer('listings_live'),
  listingsEverSeen: integer('listings_ever_seen'),
}).existing();

/** `listingsCurrent` plus the owning host's profile and portfolio. */
export const listingsCurrentWithHost = pgView('listings_current_with_host', {
  ...listingColumns,
  hostName: varchar('host_name'),
  hostYearsHosting: integer('host_years_hosting'),
  hostHostingStartedOn: day('host_hosting_started_on'),
  hostListingsLive: integer('host_listings_live'),
  hostListingsEverSeen: integer('host_listings_ever_seen'),
}).existing();

// --------------------------------------------------------------------------
// Municipal STR registry

/** The latest registry run that completed its writes. One row, one column. */
export const latestRegistryDate = pgView('latest_registry_date', {
  scrapeDate: day('scrape_date'),
}).existing();

/** The most recent read of each CityView license page. */
export const licensePagesLatest = pgView('license_pages_latest', {
  licenseId: integer('license_id'),
  scrapeDate: day('scrape_date'),
  licenseeNumber: varchar('licensee_number'),
  businessName: varchar('business_name'),
  licenseType: varchar('license_type'),
  status: varchar('status'),
  description: varchar('description'),
  locations: structList<LicenseLocation>(LICENSE_LOCATIONS_TYPE)('locations'),
  issuances: structList<LicenseIssuance>(LICENSE_ISSUANCES_TYPE)('issuances'),
}).existing();

/** `registrations` and `registrations_current` share these columns. */
const registrationColumns = {
  registrationNumber: varchar('registration_number'),
  applicationNumber: varchar('application_number'),
  licenseId: integer('license_id'),
  status: varchar('status'),
  submittedDate: day('submitted_date'),
  issuedDate: day('issued_date'),
  expiresDate: day('expires_date'),
  businessName: varchar('business_name'),
  location: varchar('location'),
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
  airbnbListingsCurrent: integer('airbnb_listings_current'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  isCurrent: boolean('is_current'),
} as const;

/** One row per registration ever published, with its latest license page. */
export const registrations = pgView('registrations', registrationColumns).existing();

/** The registrations in the latest registry run: the Muni publishes only active ones. */
export const registrationsCurrent = pgView(
  'registrations_current',
  registrationColumns,
).existing();

/** `listingsCurrent` plus the registration its page cites, if the registry has it. */
export const listingsCurrentWithRegistration = pgView('listings_current_with_registration', {
  ...listingColumns,
  registrationFound: boolean('registration_found'),
  registrationIsCurrent: boolean('registration_is_current'),
  registrationBusinessName: varchar('registration_business_name'),
  registrationLocation: varchar('registration_location'),
  registrationParcelId: varchar('registration_parcel_id'),
  registrationParcelType: varchar('registration_parcel_type'),
  registrationCommunityCouncil: varchar('registration_community_council'),
  registrationIssuedDate: day('registration_issued_date'),
  registrationExpiresDate: day('registration_expires_date'),
  registrationLicenseDescription: varchar('registration_license_description'),
  registrationAirbnbListingsCurrent: integer('registration_airbnb_listings_current'),
}).existing();
