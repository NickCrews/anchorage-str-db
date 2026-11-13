/**
 * The Municipal Clerk's STR registration layer on ArcGIS. The layer answers
 * only with a token, so these tables are an archive that nothing writes.
 * `registrations` takes the layer's geocoding from it for a license whose own
 * address has no match.
 *
 * - `muni_str_registration_observations`: append-only, one row per
 *   (registration, registry run). The layer listed only active
 *   registrations, so a registration's absence from a run is the only record
 *   that it lapsed.
 * - `muni_str_registry_runs`: one row per registry run, which read the
 *   registration layer and then a batch of license pages.
 */

import {
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/pg-core';

import { day, naiveTimestamp } from './columns.ts';

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
