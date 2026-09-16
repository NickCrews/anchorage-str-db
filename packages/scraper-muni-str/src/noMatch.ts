/**
 * What the registration layer publishes for an address its geocoder could not
 * match. Kept in a module of its own, with no imports, so the `registrations`
 * view can name the same value the layer does: see `registrationLayers.ts`,
 * which re-exports both.
 */

/** The `GeocodedAddress` of an unmatched address. */
export const NO_MATCH_GEOCODED_ADDRESS = 'Incomplete address provided. No Match.';

/** The placeholder point every unmatched address sits on. */
export const NO_MATCH_POINT = { lng: -150.20935, lat: 61.153442 } as const;
