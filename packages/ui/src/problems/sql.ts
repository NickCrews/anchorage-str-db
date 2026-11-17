/**
 * The queries behind the registration problems page: one row per active
 * listing with a registration problem, with the other listings that show its
 * id and the registrations near it, and the distance counts the method
 * section quotes. `problems.ts` sorts the rows into problems.
 */

/** Distance in meters between two lat/lng pairs, as SQL. */
const metersSql = (lat1: string, lng1: string, lat2: string, lng2: string) =>
  `2 * 6371000 * asin(sqrt(
     pow(sin(radians(${lat2} - ${lat1}) / 2), 2)
     + cos(radians(${lat1})) * cos(radians(${lat2})) * pow(sin(radians(${lng2} - ${lng1}) / 2), 2)
   ))`;

/**
 * A listing farther than this from its registration's geocoded coordinate is
 * somewhere else, and a listing within it is at the registered address.
 * Jittered coordinates sit within about 200 m of their registration, and no
 * linked listing sits between 500 m and 1 km; see
 * docs/research/registration-location-mismatch.
 */
export const FAR_METERS = 500;

/** Registrations within this distance of a listing are the ones that may cover it. */
export const NEAR_METERS = 200;

/**
 * Every active listing whose id is missing, not on file or lapsed, or whose
 * registration is more than `FAR_METERS` away. `base_problem` is `no-id`,
 * `not-on-file`, `lapsed` or `far`. Airbnb listing and host ids exceed 2^53,
 * so they are text.
 */
export const CASES_SQL = `
WITH listing AS (
  SELECT
    l.listing_id, l.name, l.url, l.listing_type, l.bedrooms, l.guest_capacity,
    l.location_lat AS lat, l.location_lng AS lng, l.location_is_exact AS pin_is_exact,
    l.host_id, l.host_name, l.page_seen_date, l.registration_id,
    r.registration_id IS NOT NULL AS on_file,
    r.is_active AS registration_is_active,
    ${metersSql('l.location_lat', 'l.location_lng', 'r.geocoded_lat', 'r.geocoded_lng')} AS meters
  FROM listings_active_with_host l
  LEFT JOIN registrations r USING (registration_id)
),
newest AS (
  SELECT max(registration_id) AS newest_registration_id FROM registrations
),
problem AS (
  SELECT
    *,
    CASE
      WHEN registration_id IS NULL THEN 'no-id'
      WHEN NOT on_file THEN 'not-on-file'
      WHEN NOT registration_is_active THEN 'lapsed'
      WHEN meters > ${FAR_METERS} THEN 'far'
    END AS base_problem
  FROM listing
),
geocoded AS (
  SELECT registration_id, business_name, registered_address, geocoded_lat, geocoded_lng, status_url
  FROM registrations_active
  WHERE geocoded_lat IS NOT NULL
)
SELECT
  p.base_problem,
  p.listing_id::VARCHAR AS listing_id,
  p.name AS listing_name,
  p.url AS listing_url,
  p.listing_type,
  p.bedrooms,
  p.guest_capacity,
  p.lat AS listing_lat,
  p.lng AS listing_lng,
  coalesce(p.pin_is_exact, false) AS listing_pin_is_exact,
  p.host_id::VARCHAR AS host_id,
  p.host_name,
  p.page_seen_date AS listing_seen_date,
  ph.photo_urls[1] AS photo_url,
  round(p.meters)::INT AS distance_m,
  p.registration_id,
  p.registration_id > n.newest_registration_id AS newer_than_newest,
  r.status AS registration_status,
  r.business_name,
  r.registered_address,
  r.geocoded_address,
  r.geocoded_lat AS registered_lat,
  r.geocoded_lng AS registered_lng,
  r.community_council,
  r.issued_date,
  r.status_url AS license_url,
  (
    SELECT list({
      'listing_id': o.listing_id::VARCHAR,
      'name': o.name,
      'url': o.url,
      'lat': o.lat,
      'lng': o.lng,
      'pin_is_exact': coalesce(o.pin_is_exact, false),
      'host_name': o.host_name,
      'distance_m': round(o.meters)::INT
    } ORDER BY o.meters)
    FROM listing o
    WHERE o.registration_id = p.registration_id
  ) AS listings_on_registration,
  (
    SELECT list({
      'registration_id': g.registration_id,
      'business_name': g.business_name,
      'address': g.registered_address,
      'lat': g.geocoded_lat,
      'lng': g.geocoded_lng,
      'license_url': g.status_url,
      'distance_m': round(${metersSql('p.lat', 'p.lng', 'g.geocoded_lat', 'g.geocoded_lng')})::INT
    } ORDER BY ${metersSql('p.lat', 'p.lng', 'g.geocoded_lat', 'g.geocoded_lng')})
    FROM geocoded g
    WHERE g.registration_id IS DISTINCT FROM p.registration_id
      AND abs(g.geocoded_lat - p.lat) < 0.01
      AND ${metersSql('p.lat', 'p.lng', 'g.geocoded_lat', 'g.geocoded_lng')} < ${NEAR_METERS}
  ) AS registrations_near_listing
FROM problem p
LEFT JOIN registrations r USING (registration_id)
LEFT JOIN listing_photos_current ph USING (listing_id)
CROSS JOIN newest n
WHERE p.base_problem IS NOT NULL
ORDER BY p.registration_id NULLS LAST, p.meters DESC, p.name
`;

/** How far each linked listing is from its registration, and the dates of both sources. */
export const SUMMARY_SQL = `
WITH linked AS (
  SELECT ${metersSql('l.location_lat', 'l.location_lng', 'r.geocoded_lat', 'r.geocoded_lng')} AS meters
  FROM listings_active l
  JOIN registrations_active r USING (registration_id)
  WHERE r.geocoded_lat IS NOT NULL AND l.location_lat IS NOT NULL
)
SELECT
  (SELECT count(*) FROM listings_active)::INT AS active,
  count(*)::INT AS compared,
  count(*) FILTER (WHERE meters <= ${NEAR_METERS})::INT AS within_200_m,
  count(*) FILTER (WHERE meters > ${NEAR_METERS} AND meters <= ${FAR_METERS})::INT AS from_200_to_500_m,
  count(*) FILTER (WHERE meters > ${FAR_METERS} AND meters <= 1000)::INT AS from_500_m_to_1_km,
  count(*) FILTER (WHERE meters > 1000)::INT AS over_1_km,
  (SELECT last_success_date FROM source_freshness WHERE source = 'airbnb') AS listing_date,
  (SELECT last_success_date FROM source_freshness WHERE source = 'muni_licenses') AS license_date
FROM linked
`;

export type BaseProblem = 'no-id' | 'not-on-file' | 'lapsed' | 'far';

export type ListingOnRegistration = {
  listing_id: string;
  name: string | null;
  url: string | null;
  lat: number;
  lng: number;
  pin_is_exact: boolean;
  host_name: string | null;
  distance_m: number | null;
};

export type NearbyRegistration = {
  registration_id: string;
  business_name: string | null;
  address: string | null;
  lat: number;
  lng: number;
  license_url: string | null;
  distance_m: number;
};

export type CaseRow = {
  base_problem: BaseProblem;
  listing_id: string;
  listing_name: string | null;
  listing_url: string | null;
  listing_type: string | null;
  bedrooms: string | null;
  guest_capacity: number | null;
  listing_lat: number;
  listing_lng: number;
  listing_pin_is_exact: boolean;
  host_id: string | null;
  host_name: string | null;
  listing_seen_date: number | null;
  photo_url: string | null;
  distance_m: number | null;
  registration_id: string | null;
  newer_than_newest: boolean | null;
  registration_status: string | null;
  business_name: string | null;
  registered_address: string | null;
  geocoded_address: string | null;
  registered_lat: number | null;
  registered_lng: number | null;
  community_council: string | null;
  issued_date: number | null;
  license_url: string | null;
  listings_on_registration: ListingOnRegistration[] | null;
  registrations_near_listing: NearbyRegistration[] | null;
};

export type SummaryRow = {
  active: number;
  compared: number;
  within_200_m: number;
  from_200_to_500_m: number;
  from_500_m_to_1_km: number;
  over_1_km: number;
  listing_date: number | null;
  license_date: number | null;
};
