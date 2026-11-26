/**
 * How Airbnb jitters a listing's coordinate, and which points a jittered
 * coordinate can come from. See `docs/research/airbnb-jitter/README.md`.
 *
 * Airbnb offsets latitude and longitude independently, each by a random sign
 * times a uniform distance in degrees between `JITTER_MIN_DEGREES` and
 * `JITTER_MAX_DEGREES`. The offset is in degrees, not meters, so at
 * Anchorage's latitude it reaches about 133 m north–south and 64 m east–west.
 * The true point therefore lies in a box around the jittered pin, outside a
 * cross of half-width `JITTER_MIN_DEGREES` through it, and every point in that
 * region is equally likely: being nearer the pin makes a point no more likely.
 */

/** The smallest per-axis offset, in degrees. */
export const JITTER_MIN_DEGREES = 0.0002;

/** The largest per-axis offset, in degrees. */
export const JITTER_MAX_DEGREES = 0.0012;

/**
 * Tolerance for comparing a jittered pin with a geocoded address point: the
 * Muni geocoder places a point a median 17 m from the host's exact pin, and
 * at 30 m a listing's own registration passes `jitterFits` for 97% of
 * jittered listings.
 */
export const GEOCODE_TOLERANCE_METERS = 30;

/** Meters per degree of latitude on a sphere of the mean Earth radius. */
export const METERS_PER_DEGREE_LAT = (6_371_008.8 * Math.PI) / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Whether `point` can be the true location behind the jittered coordinate
 * `pin`. `toleranceMeters` widens the region on every edge for error in
 * `point` itself, such as `GEOCODE_TOLERANCE_METERS` for a geocoded address.
 */
export function jitterFits(pin: LatLng, point: LatLng, toleranceMeters = 0): boolean {
  const latTolerance = toleranceMeters / METERS_PER_DEGREE_LAT;
  const lngTolerance = latTolerance / Math.cos((pin.lat * Math.PI) / 180);
  return (
    axisFits(Math.abs(point.lat - pin.lat), latTolerance) &&
    axisFits(Math.abs(point.lng - pin.lng), lngTolerance)
  );
}

function axisFits(offset: number, tolerance: number): boolean {
  return offset >= JITTER_MIN_DEGREES - tolerance && offset <= JITTER_MAX_DEGREES + tolerance;
}
