/**
 * Views over the `muni_license_` tables and the `muni_address_` and
 * `muni_parcel_` tables that geocode them. `licenses` has one row per visible
 * license with its latest page read.
 */

/** The license type whose STR Certificates are registrations. */
export const SHORT_TERM_RENTALS = 'Short-Term Rentals';

/** The issuance type whose number is a `registration_id`. */
export const STR_CERTIFICATE = 'STR Certificate';

/**
 * Issuance statuses that make a license active. A Short-Term Rentals
 * license's STR Certificate reads `Active`; a new Business License reads
 * `Issued`. `Expired` and `Pending` are not active.
 */
export const ACTIVE_ISSUANCE_STATUSES = ['Active', 'Issued'] as const;

export const MUNI_LICENSE_VIEWS_SQL = `
-- The latest license scan that completed its writes. The registry is the
-- Short-Term Rentals licenses among the license pages, so this is the date
-- \`registrations\` is current to.
CREATE OR REPLACE VIEW latest_registry_date AS
SELECT max(scrape_date) AS scrape_date FROM muni_license_runs
WHERE error_summary IS NULL;

-- One row per license with a visible page, of any license type: the latest
-- page read of each id, without its scrape_date, plus the first and last
-- dates it was read visible. An id whose latest read found it hidden is left
-- out.
--
-- is_active: the license's most recent issuance (latest issued_date; the
-- page lists newest first, so the first of a tie or of undated ones) has
-- status Active or Issued. The page's own Application Status is Active on
-- licenses whose only issuance expired, so it is not used.
--
-- address: the Address location (a property record's address), else the
-- first location that is not a parcel id, which is usually the text the
-- licensee typed. parcel_id: the parcel id when the page names exactly one.
-- geocoded_* and community_council are the Muni geocoder's match for the
-- address (muni_address_geocodes), NULL when it has none or has not been
-- asked yet; parcel_type is the parcel's Property_Type (muni_parcel_types).
CREATE OR REPLACE VIEW licenses AS
WITH read_dates AS (
    SELECT
        cityview_license_id,
        min(scrape_date) AS first_read_date,
        max(scrape_date) AS last_read_date
    FROM muni_license_page_reads
    GROUP BY cityview_license_id
),
hidden_dates AS (
    SELECT cityview_license_id, max(scrape_date) AS last_hidden_date
    FROM muni_license_hidden_reads
    GROUP BY cityview_license_id
),
latest AS (
    SELECT p.*
    FROM muni_license_page_reads p
    JOIN read_dates d
      ON d.cityview_license_id = p.cityview_license_id
     AND d.last_read_date = p.scrape_date
),
places AS (
    SELECT
        cityview_license_id,
        coalesce(
            [l.value FOR l IN locations IF l.label = 'Address'][1],
            [l.value FOR l IN locations IF l.label IS DISTINCT FROM 'Property'][1]
        ) AS address,
        CASE WHEN len([l FOR l IN locations IF l.label = 'Property']) = 1
             THEN [l.value FOR l IN locations IF l.label = 'Property'][1] END AS parcel_id
    FROM latest
),
latest_issuance AS (
    SELECT cityview_license_id, issuance.status AS issuance_status
    FROM (
        SELECT
            cityview_license_id,
            unnest(issuances) AS issuance,
            generate_subscripts(issuances, 1) AS position
        FROM latest
    )
    QUALIFY row_number() OVER (
        PARTITION BY cityview_license_id
        ORDER BY issuance.issued_date DESC NULLS LAST, position
    ) = 1
)
SELECT
    l.* EXCLUDE (scrape_date),
    d.first_read_date,
    d.last_read_date,
    coalesce(i.issuance_status IN (${ACTIVE_ISSUANCE_STATUSES.map((s) => `'${s}'`).join(', ')}), false) AS is_active,
    p.address,
    p.parcel_id,
    g.matched_address AS geocoded_address,
    g.lat AS geocoded_lat,
    g.lng AS geocoded_lng,
    g.community_council,
    t.property_type AS parcel_type
FROM latest l
JOIN read_dates d ON d.cityview_license_id = l.cityview_license_id
JOIN places p ON p.cityview_license_id = l.cityview_license_id
LEFT JOIN hidden_dates h ON h.cityview_license_id = l.cityview_license_id
LEFT JOIN latest_issuance i ON i.cityview_license_id = l.cityview_license_id
LEFT JOIN muni_address_geocodes g ON g.address = p.address
LEFT JOIN muni_parcel_types t ON t.parcel_id = p.parcel_id
WHERE h.last_hidden_date IS NULL OR h.last_hidden_date < d.last_read_date;

COMMENT ON VIEW latest_registry_date IS 'The latest license scan that completed its writes (muni_license_runs with no error_summary).';
COMMENT ON VIEW licenses IS 'One row per CityView license with a visible page, of any type (Short-Term Rentals, Business, Alcohol): its latest page read, first_read_date and last_read_date. Licenses whose latest read found the id hidden are left out. is_active means the most recent issuance''s status is Active or Issued. geocoded_* and community_council are the Muni geocoder''s match for address; parcel_type is the Property_Type of parcel_id.';
`;
