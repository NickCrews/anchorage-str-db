/**
 * The closed sets of values Airbnb columns hold. Code that writes or filters
 * on these columns takes its values from here, in TypeScript and in the SQL
 * it builds (`sqlLiteral`, `sqlList`). This module imports nothing, so the
 * browser UI can use it too.
 */

/**
 * `listing_type`: how much of a place the guest books. airbnb-dlp's
 * `roomType`; `airbnb-scraper` checks at compile time that the two sets are
 * the same.
 */
export const LISTING_TYPES = ['entire_home', 'private_room', 'shared_room', 'hotel_room'] as const;
export type ListingType = (typeof LISTING_TYPES)[number];

/**
 * `building_type`: what a listing is in, Airbnb's `propertyType`. Every value
 * read from the 2,234 active Anchorage listing pages on 2026-11-28, plus
 * those airbnb-dlp documents. A value outside the set is stored as NULL,
 * which `building_type_coverage` counts.
 */
export const BUILDING_TYPES = [
  'APARTMENT',
  'BNB',
  'BOUTIQUE_HOTEL',
  'BUNGALOW',
  'CABIN',
  'CHALET',
  'CONDOMINIUM',
  'COTTAGE',
  'DOME',
  'EARTHHOUSE',
  'FARMSTAY',
  'GUESTHOUSE',
  'HOSTEL',
  'HOTEL',
  'HOUSE',
  'LOFT',
  'NATURE_ECO_LODGE',
  'OTHER',
  'PRIVATE_SUITE',
  'RV',
  'SERVICED_APARTMENT',
  'SHIPPING_CONTAINER',
  'TENT',
  'TINY_HOUSE',
  'TOWNHOUSE',
  'VACATION_HOME',
  'VILLA',
  'YURT',
] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

export function isBuildingType(value: string): value is BuildingType {
  return (BUILDING_TYPES as readonly string[]).includes(value);
}

/** A value of one of the closed sets above. */
export type AirbnbValue = ListingType | BuildingType;

/** A SQL string literal: `sqlLiteral('entire_home')` is `'entire_home'`. Only a known value compiles. */
export function sqlLiteral(value: AirbnbValue): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A parenthesized SQL list of string literals, for `IN`: `('private_room', 'shared_room')`. */
export function sqlList(values: readonly AirbnbValue[]): string {
  return `(${values.map(sqlLiteral).join(', ')})`;
}
