/**
 * The tables, as Drizzle definitions, one file per source. `drizzle-kit
 * generate` turns a change here into a migration in `../../drizzle`, which
 * `connect` applies.
 *
 * Each table holds one source's data as published, and is written only by
 * that source's ingest app:
 *
 * - `airbnb.ts`: `airbnb_` tables, written by `ingest-airbnb`.
 * - `muniLicenses.ts`: `muni_license_` tables, the Muni's CityView license
 *   pages, written by `ingest-muni-licenses`.
 * - `muniGis.ts`: `muni_address_` and `muni_parcel_` tables, the Muni's GIS
 *   services, written by `ingest-muni-licenses`.
 * - `muniStrRegistry.ts`: `muni_str_` tables, the Municipal Clerk's STR
 *   registration layer: an archive nothing writes.
 *
 * Views combine and clean the tables (see `../views`). They are named for what
 * they derive (`listings`, `registrations`) and carry no prefix.
 *
 * Column order is the physical order: `appendRows` writes values in the
 * order the columns are declared, and `connect` rejects a database whose
 * tables differ. Add a column at the end of its table.
 */

export * from './airbnb.ts';
export * from './muniLicenses.ts';
export * from './muniGis.ts';
export * from './muniStrRegistry.ts';
