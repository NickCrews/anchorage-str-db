/**
 * Views that join sources. `registrations` has one row per STR Certificate
 * number on a Short-Term Rentals license, filled in from the archived
 * registration layer and counted against Airbnb's active listings, and
 * `listings_active_with_registration` joins Airbnb listings to it on the
 * registration id.
 */

import { SHORT_TERM_RENTALS, STR_CERTIFICATE } from './muniLicenses.ts';

/**
 * The registration layer's `GeocodedAddress` for an address the Muni's
 * geocoder could not match, which comes with a placeholder coordinate
 * (-150.20935, 61.153442).
 */
export const NO_MATCH_GEOCODED_ADDRESS = 'Incomplete address provided. No Match.';

/** CityView's own row id for an archived registration's license, read from its `status_url`. */
export const CITYVIEW_LICENSE_ID_SQL = "nullif(regexp_extract(status_url, '[?&]licenseId=(\\d+)', 1), '')::INTEGER";

export const COMBINED_VIEWS_SQL = `
-- One row per registration: each STR Certificate number on a Short-Term
-- Rentals license in \`licenses\`, plus each registration only the archived
-- registration layer holds.
--
-- From the license page: the ids, business_name, registered_address (the
-- license's address) and the license_* columns. From the STR Certificate
-- issuance: status, issued_date, expires_date, and is_active (its status is
-- Active). first_seen_date and last_seen_date are the first and latest page
-- reads that show the number.
--
-- geocoded_* and community_council are the license's own geocode when the
-- geocoder matched its address, else the registration's latest row in the
-- archived layer. parcel_type is the license's parcel's Property_Type only:
-- the layer's ParcelType is a different classification ('Residential',
-- 'Commercial'), so it is not mixed in. submitted_date comes from the
-- archive alone. Each is NULL when its source has nothing.
--
-- A registration in the archive whose number no license in \`licenses\`
-- shows keeps its layer row: is_active is false, the license_* columns are
-- NULL, and first_seen_date and last_seen_date are its layer dates.
CREATE OR REPLACE VIEW registrations AS
WITH certificates AS (
    SELECT
        * EXCLUDE (issuance),
        issuance.number AS registration_id,
        issuance.status AS issuance_status,
        issuance.issued_date AS issuance_issued_date,
        issuance.expires_date AS issuance_expires_date
    FROM (
        SELECT
            *,
            unnest(issuances) AS issuance,
            generate_subscripts(issuances, 1) AS position
        FROM licenses
        WHERE license_type = '${SHORT_TERM_RENTALS}'
    )
    WHERE issuance.type = '${STR_CERTIFICATE}' AND issuance.number IS NOT NULL
    -- A number on two licenses, or twice on one, takes the latest read and
    -- then the most recent issuance.
    QUALIFY row_number() OVER (
        PARTITION BY issuance.number
        ORDER BY last_read_date DESC, issuance.issued_date DESC NULLS LAST,
                 position, cityview_license_id DESC
    ) = 1
),
sightings AS (
    SELECT
        issuance.number AS registration_id,
        min(scrape_date) AS first_seen_date,
        max(scrape_date) AS last_seen_date
    FROM (
        SELECT scrape_date, unnest(issuances) AS issuance
        FROM muni_license_page_reads
        WHERE license_type = '${SHORT_TERM_RENTALS}'
    )
    WHERE issuance.type = '${STR_CERTIFICATE}' AND issuance.number IS NOT NULL
    GROUP BY 1
),
archived AS (
    SELECT *, ${CITYVIEW_LICENSE_ID_SQL} AS cityview_license_id
    FROM muni_str_registration_observations
    QUALIFY row_number() OVER (PARTITION BY registration_id ORDER BY scrape_date DESC) = 1
),
archived_dates AS (
    SELECT
        registration_id,
        min(scrape_date) AS first_seen_date,
        max(scrape_date) AS last_seen_date
    FROM muni_str_registration_observations
    GROUP BY registration_id
),
airbnb AS (
    SELECT registration_id AS registration_id, count(*)::INTEGER AS listings
    FROM listings_active
    WHERE registration_id IS NOT NULL
    GROUP BY registration_id
),
combined AS (
    SELECT
        c.registration_id,
        c.license_id,
        c.cityview_license_id,
        c.issuance_status AS status,
        a.submitted_date,
        c.issuance_issued_date AS issued_date,
        c.issuance_expires_date AS expires_date,
        c.business_name,
        c.address AS registered_address,
        -- The license's geocode as a whole, or the archive's as a whole, so
        -- a coordinate and its council always come from one geocoding.
        CASE WHEN c.geocoded_address IS NOT NULL THEN c.community_council
             ELSE a.community_council END AS community_council,
        c.parcel_type,
        coalesce(c.geocoded_address, a.geocoded_address) AS geocoded_address,
        CASE WHEN c.geocoded_address IS NOT NULL THEN c.geocoded_lat
             ELSE a.geocoded_lat END AS geocoded_lat,
        CASE WHEN c.geocoded_address IS NOT NULL THEN c.geocoded_lng
             ELSE a.geocoded_lng END AS geocoded_lng,
        'https://www.muni.org/CityViewPortal/License/Status?licenseId='
            || c.cityview_license_id || '&category=B' AS status_url,
        c.last_read_date AS license_read_date,
        c.status AS license_status,
        c.license_type,
        c.description AS license_description,
        c.business_name AS license_business_name,
        c.locations AS license_locations,
        c.issuances AS license_issuances,
        s.first_seen_date,
        s.last_seen_date,
        c.issuance_status = 'Active' AS is_active
    FROM certificates c
    JOIN sightings s USING (registration_id)
    LEFT JOIN archived a USING (registration_id)
    UNION ALL
    SELECT
        a.registration_id,
        a.license_id,
        a.cityview_license_id,
        a.status,
        a.submitted_date,
        a.issued_date,
        a.expires_date,
        a.business_name,
        a.registered_address,
        a.community_council,
        NULL AS parcel_type,
        a.geocoded_address,
        a.geocoded_lat,
        a.geocoded_lng,
        a.status_url,
        NULL AS license_read_date,
        NULL AS license_status,
        NULL AS license_type,
        NULL AS license_description,
        NULL AS license_business_name,
        NULL AS license_locations,
        NULL AS license_issuances,
        d.first_seen_date,
        d.last_seen_date,
        false AS is_active
    FROM archived a
    JOIN archived_dates d USING (registration_id)
    WHERE a.registration_id NOT IN (SELECT registration_id FROM certificates)
)
SELECT
    r.registration_id,
    r.license_id,
    r.cityview_license_id,
    r.status,
    r.submitted_date,
    r.issued_date,
    r.expires_date,
    nullif(r.business_name, 'None') AS business_name,
    r.registered_address,
    r.community_council,
    r.parcel_type,
    r.geocoded_address,
    -- NULL where the archive's geocoding found no match, instead of its
    -- placeholder coordinate.
    CASE WHEN r.geocoded_address IS DISTINCT FROM '${NO_MATCH_GEOCODED_ADDRESS}'
         THEN r.geocoded_lat END AS geocoded_lat,
    CASE WHEN r.geocoded_address IS DISTINCT FROM '${NO_MATCH_GEOCODED_ADDRESS}'
         THEN r.geocoded_lng END AS geocoded_lng,
    r.status_url,
    r.license_read_date,
    r.license_status,
    r.license_type,
    r.license_description,
    r.license_business_name,
    -- Parcel ids linked to property records. A parcel id typed as text has no
    -- label and is not included (license 13990).
    [l.value FOR l IN r.license_locations IF l.label = 'Property'] AS license_parcel_ids,
    [l.value FOR l IN r.license_locations IF l.label = 'Address'] AS license_addresses,
    -- The parcel id when the license lists exactly one; join to
    -- anchorage-property's parcels on it.
    CASE WHEN len([l FOR l IN r.license_locations IF l.label = 'Property']) = 1
         THEN [l.value FOR l IN r.license_locations IF l.label = 'Property'][1] END AS parcel_id,
    r.license_issuances,
    coalesce(b.listings, 0) AS airbnb_listings_active,
    r.first_seen_date,
    r.last_seen_date,
    r.is_active
FROM combined r
LEFT JOIN airbnb b USING (registration_id);

CREATE OR REPLACE VIEW registrations_active AS
SELECT * FROM registrations WHERE is_active;

-- \`listings_active\` plus the registration its page cites. The registration
-- columns are NULL when the listing shows no number or no license page read
-- shows it: a typo, a number on a license whose page is hidden, or one issued
-- since the license scan last read new license ids.
CREATE OR REPLACE VIEW listings_active_with_registration AS
SELECT
    l.*,
    r.registration_id IS NOT NULL AS registration_found,
    r.is_active AS registration_is_active,
    r.business_name AS registration_business_name,
    r.registered_address AS registration_address,
    r.parcel_id AS registration_parcel_id,
    r.parcel_type AS registration_parcel_type,
    r.community_council AS registration_community_council,
    r.issued_date AS registration_issued_date,
    r.expires_date AS registration_expires_date,
    r.license_description AS registration_license_description,
    r.airbnb_listings_active AS registration_airbnb_listings_active
FROM listings_active l
LEFT JOIN registrations r ON r.registration_id = l.registration_id;

COMMENT ON VIEW registrations IS 'One row per STR registration: each STR Certificate number on a Short-Term Rentals license page, plus registrations only the archived registration layer holds. is_active means the STR Certificate''s status is Active; archive-only registrations are not active. geocoded_* and community_council are the license''s geocode, else the archived layer''s; parcel_type is the license''s parcel''s Property_Type; submitted_date comes from the archived layer.';
COMMENT ON VIEW listings_active_with_registration IS 'listings_active plus the Municipal registration matching registration_id. Registration columns are NULL when there is no match.';
`;
