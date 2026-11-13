/**
 * The Muni's GIS services, as the license scan reads them for the addresses
 * and parcels on license pages.
 *
 * - `muni_address_geocodes`: one row per license address the Muni's geocoder
 *   was asked about, with its community council.
 * - `muni_parcel_types`: one row per parcel id on a license, with its
 *   `Property_Type` from the Muni's property information layer.
 *
 * The license scan writes both after its page reads. `licenses` and
 * `registrations` join them on the address and the parcel id.
 */

import {
  boolean,
  doublePrecision,
  pgTable,
  varchar,
} from 'drizzle-orm/pg-core';

import { day } from './columns.ts';

/**
 * One row per address, as a license page shows it, sent to the Muni's
 * geocoder (`MOA_Multirole_Locator`). A row with no match is kept, so the
 * address is not asked about again until the license scan's retry interval
 * passes; the next answer replaces the row. A failed request writes no row.
 */
export const muniAddressGeocodes = pgTable('muni_address_geocodes', {
  // Verbatim from the license page, so it joins to licenses.address.
  address: varchar('address').primaryKey(),
  // The scrape date of the license scan that asked.
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

/**
 * One row per parcel id a license names, read from the Muni's
 * `PropertyInformation_Hosted` layer. Re-read after the license scan's refresh
 * interval; the next read replaces the row. A failed query writes no row.
 */
export const muniParcelTypes = pgTable('muni_parcel_types', {
  parcelId: varchar('parcel_id').primaryKey(),
  // The scrape date of the license scan that read it.
  readDate: day('read_date').notNull(),
  // Whether the layer has a row for the parcel id.
  inLayer: boolean('in_layer').notNull(),
  // The layer's Property_Type, verbatim: 'RESIDENTIAL', 'CONDO',
  // 'APARTMENT', 'COMMERCIAL', ... NULL when not in the layer or blank there.
  propertyType: varchar('property_type'),
});
