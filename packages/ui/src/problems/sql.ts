/**
 * Registration problems: active listings whose registration id is missing,
 * not on file, lapsed, or registered far from the listing.
 */

/** Distance in meters between two lat/lng pairs, as SQL. */
export const metersBetweenSql = (lat1: string, lng1: string, lat2: string, lng2: string) =>
  `2 * 6371000 * asin(sqrt(
     pow(sin(radians(${lat2} - ${lat1}) / 2), 2)
     + cos(radians(${lat1})) * cos(radians(${lat2})) * pow(sin(radians(${lng2} - ${lng1}) / 2), 2)
   ))`;

/**
 * A listing farther than this from its registration's geocoded coordinate is
 * somewhere else. Jittered coordinates sit within about 200 m of the
 * registration; see docs/research/registration-location-mismatch.
 */
export const FAR_METERS = 500;

/** A listing within this distance of its registration is at the registered address. */
export const AT_ADDRESS_METERS = 200;

export const PROBLEMS = [
  {
    key: 'No id',
    title: 'No registration id',
    meaning: 'The listing shows no Muni registration id, which every listing has had to show since July 31, 2026.',
    fix: 'Ask the host to register the rental and show its id on the listing.',
  },
  {
    key: 'Id not on file',
    title: 'Id not on file',
    meaning:
      "The id the listing shows is on no license page the Muni publishes. It can be a typo, an id on a license whose page is hidden, or one issued since our last read of the Muni's records.",
    fix: 'Ask the host which registration the rental holds, and to correct the id on the listing.',
  },
  {
    key: 'Lapsed',
    title: 'Registration lapsed',
    meaning: "The listing shows a registration whose STR Certificate's status is no longer Active.",
    fix: 'Ask the registrant to renew, or the host to stop renting.',
  },
  {
    key: 'One id, two places',
    title: 'One id, two places',
    meaning: `Another listing with the same id is at the registered address, and this one is more than ${FAR_METERS} m away. One registration may be covering a second rental.`,
    fix: 'Ask the host to register the second rental and show that id on its listing.',
  },
  {
    key: 'Not at the registered address',
    title: 'Not at the registered address',
    meaning: `The listing is more than ${FAR_METERS} m from the address its registration gives, and no listing with that id is at that address. The host may have copied another rental's id, or the registration may have the wrong address.`,
    fix: 'Ask the registrant where the rental is, and correct the listing or the registration.',
  },
] as const;

export type ProblemKey = (typeof PROBLEMS)[number]['key'];

/**
 * One row per active listing with a registration problem. Airbnb listing and
 * host ids exceed 2^53, so they are text.
 */
export const PROBLEMS_SQL = `
WITH host_names AS (
  SELECT host_id, name AS host_name
  FROM hosts
  QUALIFY row_number() OVER (PARTITION BY host_id ORDER BY valid_from DESC) = 1
),
newest AS (
  SELECT max(registration_id) AS newest_registration_id FROM registrations
),
placed AS (
  SELECT
    l.listing_id, l.name, l.url, l.listing_type, l.host_id, l.registration_id,
    l.location_is_exact, l.first_seen_date,
    r.registration_id IS NOT NULL AS on_file,
    r.is_active AS registration_is_active,
    r.status AS registration_status,
    r.business_name AS registrant,
    r.registered_address,
    r.status_url,
    ${metersBetweenSql('l.location_lat', 'l.location_lng', 'r.geocoded_lat', 'r.geocoded_lng')} AS meters
  FROM listings_active l
  LEFT JOIN registrations r USING (registration_id)
),
by_id AS (
  SELECT
    registration_id,
    count(*) AS listings_showing,
    count(*) FILTER (WHERE meters <= ${AT_ADDRESS_METERS}) AS listings_at_address
  FROM placed
  WHERE registration_id IS NOT NULL
  GROUP BY registration_id
),
classified AS (
  SELECT
    p.*,
    coalesce(b.listings_showing, 0) AS listings_showing,
    CASE
      WHEN p.registration_id IS NULL THEN 'No id'
      WHEN NOT p.on_file THEN 'Id not on file'
      WHEN NOT p.registration_is_active THEN 'Lapsed'
      WHEN p.meters > ${FAR_METERS} AND b.listings_at_address > 0 THEN 'One id, two places'
      WHEN p.meters > ${FAR_METERS} THEN 'Not at the registered address'
    END AS problem
  FROM placed p
  LEFT JOIN by_id b USING (registration_id)
)
SELECT
  c.problem,
  c.listing_id::VARCHAR AS listing_id,
  c.name AS listing,
  c.url,
  c.listing_type,
  c.host_id::VARCHAR AS host_id,
  coalesce(h.host_name, '(unknown)') AS host,
  c.registration_id,
  c.registration_status,
  c.registrant,
  c.registered_address,
  c.status_url,
  round(c.meters)::INT AS meters,
  c.location_is_exact,
  c.listings_showing::INT AS listings_showing,
  c.problem = 'Id not on file' AND c.registration_id > n.newest_registration_id AS newer_than_newest,
  c.first_seen_date
FROM classified c
LEFT JOIN host_names h USING (host_id)
CROSS JOIN newest n
WHERE c.problem IS NOT NULL
ORDER BY c.problem, c.registration_id, host, listing
`;

export type ProblemRow = {
  problem: ProblemKey;
  listing_id: string;
  listing: string | null;
  url: string | null;
  listing_type: string | null;
  host_id: string | null;
  host: string;
  registration_id: string | null;
  registration_status: string | null;
  registrant: string | null;
  registered_address: string | null;
  status_url: string | null;
  meters: number | null;
  location_is_exact: boolean | null;
  listings_showing: number;
  newer_than_newest: boolean | null;
  first_seen_date: number | null;
};
