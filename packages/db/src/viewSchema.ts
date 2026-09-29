/**
 * The views' columns: what each view in `views.ts` returns, declared so that
 * everything reading the database — the scraper's checks and the viewer's
 * queries — is built from the same names and types the tables in `schema.ts`
 * give it. A renamed or retyped view column is then a type error in every
 * query that reads it, rather than a query that returns nothing in the
 * browser.
 *
 * The views themselves are DuckDB SQL in `views.ts`, which is where to read
 * what each one means and how it is computed. These are declarations only
 * (`.existing()`: Drizzle never creates them), so `connect` compares every one
 * against the view DuckDB built, column for column, and refuses the database
 * if they differ. A change to a view's SQL that adds, drops, renames or
 * retypes a column has to be carried over here, in the same order.
 *
 * Every column is nullable. DuckDB reports no nullability for a view, so a
 * `notNull()` here would be an unchecked claim, and most of these columns
 * really can be NULL: a listing whose page was never read has no
 * `listing_type`, a registration the geocoder could not place has no
 * `geocoded_lat`.
 *
 * Nothing here reaches a driver, so the viewer can import it. See the README
 * for which modules are safe to import in a browser.
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

/** The latest run that completed its writes. One row, one column. */
export const latestScrapeDate = pgView('latest_scrape_date', {
  scrapeDate: day('scrape_date'),
}).existing();

/** Per listing: first and last seen, last successful page read, and whether active. */
export const listingActivity = pgView('listing_activity', {
  listingId: bigint('listing_id'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  pageSeenDate: day('page_seen_date'),
  isActive: boolean('is_active'),
}).existing();

/** SCD2 versions of each listing's attributes. */
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
}).existing();

/**
 * `listings` and everything built on it start with these columns, in this
 * order, because each of those views selects `l.*` and appends its own.
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
export const listings = pgView('listings', listingColumns).existing();

/** `listings` filtered to the current version of each active listing. */
export const listingsActive = pgView('listings_active', listingColumns).existing();

/** Each listing's most recent photo set; `photoUrls[1]` is the cover photo. */
export const listingPhotosCurrent = pgView('listing_photos_current', {
  listingId: bigint('listing_id'),
  photoUrls: varcharList('photo_urls'),
  photoCount: integer('photo_count'),
  photosValidFrom: day('photos_valid_from'),
}).existing();

/**
 * The current version of each night, minus the future nights of inactive
 * listings. A (listing, night) with no row here is not a zero; see `views.ts`.
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
}).existing();

/** Per host: first and last seen, last card read, implied hosting start, and whether active. */
export const hostActivity = pgView('host_activity', {
  hostId: bigint('host_id'),
  firstSeenDate: day('first_seen_date'),
  lastSeenDate: day('last_seen_date'),
  profileSeenDate: day('profile_seen_date'),
  hostingStartedOn: day('hosting_started_on'),
  hostingStartSpreadDays: integer('hosting_start_spread_days'),
  yearsHosting: integer('years_hosting'),
  isActive: boolean('is_active'),
}).existing();

/** SCD2 versions of each host's name and about text. */
export const hostVersions = pgView('host_versions', {
  hostId: bigint('host_id'),
  versionNo: hugeint('version_no'),
  validFrom: day('valid_from'),
  versionLastSeenDate: day('version_last_seen_date'),
  name: varchar('name'),
  about: varchar('about'),
  validTo: day('valid_to'),
}).existing();

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
}).existing();

/**
 * Listings per host per completed run date: the host's Anchorage listing
 * portfolio, counting only listings inside the Municipality. See `views.ts`.
 */
export const hostListingPortfolios = pgView('host_listing_portfolios', {
  hostId: bigint('host_id'),
  scrapeDate: day('scrape_date'),
  listingsActive: integer('listings_active'),
  listingsEverSeen: integer('listings_ever_seen'),
}).existing();

/**
 * `listingsActive` plus the host's profile and listing portfolio as of the
 * latest run. The host columns are NULL when the host is unknown.
 */
export const listingsActiveWithHost = pgView('listings_active_with_host', {
  ...listingColumns,
  hostName: varchar('host_name'),
  hostYearsHosting: integer('host_years_hosting'),
  hostHostingStartedOn: day('host_hosting_started_on'),
  hostListingsActive: integer('host_listings_active'),
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
  cityviewLicenseId: integer('cityview_license_id'),
  scrapeDate: day('scrape_date'),
  licenseId: varchar('license_id'),
  businessName: varchar('business_name'),
  licenseType: varchar('license_type'),
  status: varchar('status'),
  description: varchar('description'),
  locations: structList<LicenseLocation>(LICENSE_LOCATIONS_TYPE)('locations'),
  issuances: structList<LicenseIssuance>(LICENSE_ISSUANCES_TYPE)('issuances'),
}).existing();

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

/**
 * One row per registration ever published, with its latest published fields
 * and latest license page. `isActive` means it was in the latest registry run.
 */
export const registrations = pgView('registrations', registrationColumns).existing();

/** The registrations in the latest registry run: the Muni publishes only active ones. */
export const registrationsActive = pgView('registrations_active', registrationColumns).existing();

/**
 * `listingsActive` plus the registration its page cites. The registration
 * columns are NULL when the listing shows no id or the id is not in the
 * registry, which includes ids issued since the layer's last publish.
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
}).existing();

/**
 * Every view, in the order `views.ts` creates them.
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
