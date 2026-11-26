/**
 * The views, recreated on every `connect`. Everything downstream reads these
 * rather than the tables in `schema.ts`.
 *
 * `listings` is derived from `airbnb_listing_observations`: `listing_versions`
 * rebuilds `valid_from`/`valid_to` with gaps-and-islands, and
 * `listing_activity` derives first/last/page-seen dates. Deriving keeps those
 * dates consistent with the observations (including for relisted listings)
 * and lets a version-logic bug be fixed by editing a view rather than
 * backfilling the only copy of the archive. `hosts` is built from
 * `airbnb_host_observations` the same way.
 *
 * `licenses` has one row per visible license with its latest page read,
 * `registrations` one row per STR Certificate number on a Short-Term Rentals
 * license, and `listings_active_with_registration` joins Airbnb listings to
 * it on the registration id. `licenses` and `registrations` take parcel
 * attributes from `property_parcels` on `parcel_id`. Cleaning (the `'None'`
 * business name, the no-match placeholder coordinate) happens in the views,
 * so the raw tables can always be re-derived.
 *
 * Views are not in the Drizzle schema: they use DuckDB syntax drizzle-kit
 * cannot express, and recreating them on connect applies a change without a
 * migration.
 */

import {
  JITTER_MAX_DEGREES,
  JITTER_MIN_DEGREES,
  METERS_PER_DEGREE_LAT,
} from '@anchorage-str-db/utils/jitter';

/**
 * Days a listing may be absent from search before `listings.is_active` goes
 * false. Search occasionally omits a listing for a day.
 */
export const RETIREMENT_GRACE_DAYS = 5;

/**
 * The registration layer's `GeocodedAddress` for an address the Muni's
 * geocoder could not match, which comes with a placeholder coordinate
 * (-150.20935, 61.153442).
 */
export const NO_MATCH_GEOCODED_ADDRESS = 'Incomplete address provided. No Match.';

/**
 * The start date one `timeAsHost` reading implies. Airbnb reports whole
 * months, so this lands up to a month after the true start depending on the
 * day of the month it was read. `host_activity` takes the minimum over all
 * readings, which is why the start date is an aggregate rather than part of
 * the host version key.
 */
const IMPLIED_HOSTING_START_SQL =
  '(scrape_date - to_months(12 * time_as_host_years + time_as_host_months))::DATE';

/**
 * Attributes whose change opens a new listing version. Excludes values that
 * change most days (rating, review count, price hint) and `url`, which is
 * derived from `listing_id`. Coordinates are rounded to 6dp so float noise
 * doesn't open a version. `page` holds the listing-page fields, so a listing
 * changing hands, converting from a whole home to a private room, or changing
 * its guest, bed, bedroom or bathroom count opens a version. The price quote
 * changes most days and is not part of it. Photos are stored separately
 * and never open one: hosts reorder and replace photos far more often than
 * the listing itself changes.
 */
const VERSION_KEY_SQL = `{
    'name': name,
    'property_title': property_title,
    'lat': round(location_lat, 6),
    'lng': round(location_lng, 6),
    'badges': list_sort(badges),
    'page': page_attrs
}`;

const PAGE_ATTRS_SQL = `{
    'location_is_exact': location_is_exact,
    'location_exact_address': location_exact_address,
    'location_subtitle': location_subtitle,
    'location_verified': location_verified,
    'registration_id': registration_id,
    'host_id': host_id,
    'listing_type': listing_type,
    'guest_capacity': guest_capacity,
    'beds': beds,
    'bedrooms': bedrooms,
    'bathrooms': bathrooms
}`;

/** `{grace}` is filled from `RETIREMENT_GRACE_DAYS`. */
const LISTING_VIEWS_SQL = `
-- The date retirement is measured from: the latest run that completed its
-- writes. Observations alone would stop advancing on a day with no
-- listings; \`airbnb_scrape_runs\` alone would include failed runs, whose
-- counts are NULL.
CREATE OR REPLACE VIEW latest_scrape_date AS
SELECT max(scrape_date) AS scrape_date FROM (
    SELECT max(scrape_date) AS scrape_date FROM airbnb_listing_observations
    UNION ALL
    SELECT max(scrape_date) AS scrape_date FROM airbnb_scrape_runs
    WHERE listings_seen IS NOT NULL
);

-- Per listing: first and last seen, last successful page read, and whether
-- it is active. A listing is active if seen within RETIREMENT_GRACE_DAYS
-- of the latest scrape, because search occasionally omits a listing for a
-- day.
CREATE OR REPLACE VIEW listing_activity AS
SELECT
    listing_id,
    min(scrape_date) AS first_seen_date,
    max(scrape_date) AS last_seen_date,
    max(scrape_date) FILTER (WHERE page_fetch_ok) AS page_seen_date,
    max(scrape_date) >= (
        SELECT scrape_date FROM latest_scrape_date
    ) - INTERVAL {grace} DAY AS is_active
FROM airbnb_listing_observations
GROUP BY listing_id;

-- SCD2 versions. A version runs from the first day an attribute set was
-- observed until the next distinct set appears.
CREATE OR REPLACE VIEW listing_versions AS
WITH observed AS (
    SELECT
        * EXCLUDE (
            location_is_exact, location_exact_address, location_subtitle,
            location_verified, registration_id, host_id,
            listing_type, guest_capacity, beds, bedrooms, bathrooms
        ),
        -- NULL when the page fetch failed, so the carry-forward skips it.
        -- Carrying the whole struct keeps "read the page, no registration
        -- id" (a struct holding a NULL) distinct from "page not read"
        -- (a NULL struct).
        CASE WHEN page_fetch_ok THEN {page_attrs} END AS page_attrs
    FROM airbnb_listing_observations
),
carried AS (
    SELECT * REPLACE (
        last_value(page_attrs IGNORE NULLS) OVER (
            PARTITION BY listing_id ORDER BY scrape_date
        ) AS page_attrs
    )
    FROM observed
),
keyed AS (
    SELECT *, {version_key} AS version_key FROM carried
),
marked AS (
    SELECT *,
        CASE WHEN version_key IS DISTINCT FROM lag(version_key) OVER w
             THEN 1 ELSE 0 END AS opens_version
    FROM keyed
    WINDOW w AS (PARTITION BY listing_id ORDER BY scrape_date)
),
numbered AS (
    SELECT *,
        sum(opens_version) OVER (PARTITION BY listing_id ORDER BY scrape_date)
            AS version_no
    FROM marked
),
-- Every row in a group has the same version_key, so any_value is exact.
aggregated AS (
    SELECT
        listing_id,
        version_no,
        min(scrape_date) AS valid_from,
        max(scrape_date) AS version_last_seen_date,
        any_value(name) AS name,
        any_value(property_title) AS property_title,
        any_value(location_lat) AS location_lat,
        any_value(location_lng) AS location_lng,
        any_value(url) AS url,
        any_value(badges) AS badges,
        any_value(page_attrs) AS page_attrs
    FROM numbered
    GROUP BY listing_id, version_no
)
SELECT
    * EXCLUDE (page_attrs),
    page_attrs.location_is_exact AS location_is_exact,
    page_attrs.location_exact_address AS location_exact_address,
    page_attrs.location_subtitle AS location_subtitle,
    page_attrs.location_verified AS location_verified,
    page_attrs.registration_id AS registration_id,
    page_attrs.host_id AS host_id,
    page_attrs.listing_type AS listing_type,
    page_attrs.guest_capacity AS guest_capacity,
    page_attrs.beds AS beds,
    page_attrs.bedrooms AS bedrooms,
    page_attrs.bathrooms AS bathrooms,
    lead(valid_from) OVER (PARTITION BY listing_id ORDER BY version_no) AS valid_to
FROM aggregated;

-- The dimension every downstream query reads.
CREATE OR REPLACE VIEW listings AS
SELECT
    v.listing_id,
    v.name,
    v.property_title,
    v.listing_type,
    v.guest_capacity,
    v.beds,
    v.bedrooms,
    v.bathrooms,
    v.location_lat,
    v.location_lng,
    v.url,
    v.badges,
    v.location_is_exact,
    v.location_exact_address,
    v.location_subtitle,
    v.location_verified,
    v.registration_id,
    v.host_id,
    a.page_seen_date,
    a.first_seen_date,
    a.last_seen_date,
    r.first_review_date,
    -- The earlier of the first review and first_seen_date: the room was
    -- listed on or before this date. An estimate, not the true listing
    -- date: it can only be too late, never too early. A room with no
    -- reviews from before this project saw it gets first_seen_date and looks
    -- newer than it may be. \`least\` skips NULLs, so a listing with no
    -- reviews, or not yet resolved, gets first_seen_date.
    least(r.first_review_date, a.first_seen_date) AS first_available_date_est,
    v.version_no,
    v.version_last_seen_date,
    v.valid_from,
    v.valid_to,
    v.valid_to IS NULL AND a.is_active AS is_active
FROM listing_versions v
JOIN listing_activity a USING (listing_id)
LEFT JOIN airbnb_listing_first_reviews r USING (listing_id);

CREATE OR REPLACE VIEW listings_active AS
SELECT * FROM listings WHERE is_active;

-- Each listing's most recent photo set.
CREATE OR REPLACE VIEW listing_photos_current AS
SELECT
    listing_id,
    photo_urls,
    len(photo_urls)::INTEGER AS photo_count,
    valid_from AS photos_valid_from
FROM airbnb_listing_photos
QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY valid_from DESC) = 1;

-- The current version of each night, minus the future nights of inactive
-- listings.
--
-- An inactive listing's calendar is no longer fetched, so its future nights
-- stay is_current for up to twelve months. Nights up to its last_seen_date
-- are real observations and are kept.
--
-- A (listing, night) with no row here is not a zero: the listing had not been
-- scraped yet, had retired, the night is past Airbnb's ~12-month window, or
-- its calendar was never read. Only the second is a fact about the rental,
-- and the missing row cannot say which applies.
CREATE OR REPLACE VIEW calendar_current AS
SELECT c.*
FROM airbnb_calendar_status c
JOIN listing_activity a USING (listing_id)
WHERE c.is_current
  AND (a.is_active OR c.night_date <= a.last_seen_date);

-- Per host: first and last seen, last card read, and whether active, on
-- the same rule as \`listing_activity\`. \`hosting_started_on\` is the earliest
-- start date any reading implies, and \`hosting_start_spread_days\` how far
-- the readings disagree. Month rounding alone keeps the spread under about a
-- month; the \`host_start_date_stable\` check warns beyond that.
CREATE OR REPLACE VIEW host_activity AS
SELECT
    host_id,
    min(scrape_date) AS first_seen_date,
    max(scrape_date) AS last_seen_date,
    max(scrape_date) FILTER (WHERE profile_read_ok) AS profile_seen_date,
    min({hosting_start}) FILTER (WHERE profile_read_ok) AS hosting_started_on,
    date_diff(
        'day',
        min({hosting_start}) FILTER (WHERE profile_read_ok),
        max({hosting_start}) FILTER (WHERE profile_read_ok)
    )::INTEGER AS hosting_start_spread_days,
    -- Whole years of \`timeAsHost\` at the latest reading.
    arg_max(time_as_host_years, scrape_date)
        FILTER (WHERE profile_read_ok AND time_as_host_years IS NOT NULL) AS years_hosting,
    max(scrape_date) >= (
        SELECT scrape_date FROM latest_scrape_date
    ) - INTERVAL {grace} DAY AS is_active
FROM airbnb_host_observations
GROUP BY host_id;

-- Gaps-and-islands over (name, about), as in \`listing_versions\`. A day
-- whose card was not read contributes a NULL profile, which the carry-forward
-- skips, so a failed read neither blanks the host nor opens a version.
-- \`timeAsHost\` grows monthly, so it is summarized in \`host_activity\`
-- rather than versioned.
CREATE OR REPLACE VIEW host_versions AS
WITH observed AS (
    SELECT
        host_id,
        scrape_date,
        CASE WHEN profile_read_ok THEN {'name': name, 'about': about} END AS profile
    FROM airbnb_host_observations
),
carried AS (
    SELECT
        host_id,
        scrape_date,
        last_value(profile IGNORE NULLS) OVER (
            PARTITION BY host_id ORDER BY scrape_date
        ) AS profile
    FROM observed
),
-- Wrapped so "no card read yet" (a NULL profile) differs from lag()'s NULL
-- on the first row.
marked AS (
    SELECT *,
        CASE WHEN {'p': profile} IS DISTINCT FROM lag({'p': profile}) OVER w
             THEN 1 ELSE 0 END AS opens_version
    FROM carried
    WINDOW w AS (PARTITION BY host_id ORDER BY scrape_date)
),
numbered AS (
    SELECT *,
        sum(opens_version) OVER (PARTITION BY host_id ORDER BY scrape_date) AS version_no
    FROM marked
),
aggregated AS (
    SELECT
        host_id,
        version_no,
        min(scrape_date) AS valid_from,
        max(scrape_date) AS version_last_seen_date,
        any_value(profile) AS profile
    FROM numbered
    GROUP BY host_id, version_no
)
SELECT
    host_id,
    version_no,
    valid_from,
    version_last_seen_date,
    profile.name AS name,
    profile.about AS about,
    lead(valid_from) OVER (PARTITION BY host_id ORDER BY version_no) AS valid_to
FROM aggregated;

-- The host dimension. Join to \`listings\` on host_id; filter \`is_active\`
-- for one row per host.
CREATE OR REPLACE VIEW hosts AS
SELECT
    v.host_id,
    v.name,
    v.about,
    a.hosting_started_on,
    year(a.hosting_started_on)::INTEGER AS hosting_started_year,
    a.years_hosting,
    a.hosting_start_spread_days,
    a.profile_seen_date,
    a.first_seen_date,
    a.last_seen_date,
    v.version_no,
    v.version_last_seen_date,
    v.valid_from,
    v.valid_to,
    v.valid_to IS NULL AND a.is_active AS is_active
FROM host_versions v
JOIN host_activity a USING (host_id);

-- Listings per host per completed run date. Counts only: no threshold
-- marking a commercial host is stored; that line is drawn downstream.
--
-- listings_active       listings held by the host that were live on
--                     scrape_date: the \`listing_activity.is_active\` rule
--                     evaluated as of that date.
-- listings_ever_seen  distinct listings observed under the host on or before
--                     scrape_date, live or not.
--
-- A row exists for every run date from the host's first observation on, so
-- a portfolio winding down reads as zeros rather than missing rows. A
-- listing's host is carried forward past failed page fetches as in
-- \`listing_versions\`, so the latest date agrees with
-- \`listings_active.host_id\`. A listing whose page was never read has no
-- known host and is counted under nobody.
--
-- An Anchorage host listing portfolio: only the host's listings inside the
-- Municipality are counted, not the ones they hold elsewhere. That is a
-- limit of the data and not the question anyone is asking — a host running
-- forty dwellings from Palmer is a large operator with two listings here — but
-- nothing Airbnb publishes to us carries a host's total. See issue #34.
CREATE OR REPLACE VIEW host_listing_portfolios AS
WITH held AS (
    SELECT
        listing_id,
        scrape_date,
        -- A struct, so "read the page, no host" is not skipped over the way
        -- "page not read" is.
        last_value(
            CASE WHEN page_fetch_ok THEN {'host_id': host_id} END IGNORE NULLS
        ) OVER (PARTITION BY listing_id ORDER BY scrape_date).host_id AS host_id
    FROM airbnb_listing_observations
),
-- Completed runs, by \`latest_scrape_date\`'s definition.
run_dates AS (
    SELECT scrape_date FROM airbnb_listing_observations
    UNION
    SELECT scrape_date FROM airbnb_scrape_runs WHERE listings_seen IS NOT NULL
),
-- Each listing live on each run date, held by whoever its latest observation
-- on or before that date names.
live AS (
    SELECT d.scrape_date, h.listing_id, h.host_id
    FROM run_dates d
    JOIN held h
      ON h.scrape_date BETWEEN d.scrape_date - INTERVAL {grace} DAY AND d.scrape_date
    QUALIFY row_number() OVER (
        PARTITION BY d.scrape_date, h.listing_id ORDER BY h.scrape_date DESC
    ) = 1
),
live_counts AS (
    SELECT host_id, scrape_date, count(*) AS listings_active
    FROM live
    WHERE host_id IS NOT NULL
    GROUP BY host_id, scrape_date
),
first_held AS (
    SELECT host_id, listing_id, min(scrape_date) AS scrape_date
    FROM held
    WHERE host_id IS NOT NULL
    GROUP BY host_id, listing_id
),
newly_seen AS (
    SELECT host_id, scrape_date, count(*) AS listings_new
    FROM first_held
    GROUP BY host_id, scrape_date
),
panel AS (
    SELECT f.host_id, d.scrape_date
    FROM (SELECT host_id, min(scrape_date) AS since FROM first_held GROUP BY host_id) f
    JOIN run_dates d ON d.scrape_date >= f.since
)
SELECT
    p.host_id,
    p.scrape_date,
    coalesce(l.listings_active, 0)::INTEGER AS listings_active,
    sum(coalesce(n.listings_new, 0)) OVER (
        PARTITION BY p.host_id ORDER BY p.scrape_date
    )::INTEGER AS listings_ever_seen
FROM panel p
LEFT JOIN live_counts l USING (host_id, scrape_date)
LEFT JOIN newly_seen n USING (host_id, scrape_date);

-- \`listings_active\` plus the owning host's profile and listing portfolio as of
-- the latest run, so "is this Girdwood listing part of a large one?" needs no
-- join. The host columns are NULL when the host is unknown.
CREATE OR REPLACE VIEW listings_active_with_host AS
SELECT
    l.*,
    h.name AS host_name,
    h.years_hosting AS host_years_hosting,
    h.hosting_started_on AS host_hosting_started_on,
    p.listings_active AS host_listings_active,
    p.listings_ever_seen AS host_listings_ever_seen
FROM listings_active l
LEFT JOIN hosts h
  ON h.host_id = l.host_id AND h.valid_to IS NULL
LEFT JOIN host_listing_portfolios p
  ON p.host_id = l.host_id
 AND p.scrape_date = (SELECT scrape_date FROM latest_scrape_date);

-- Stored in the file, so readers of the published .duckdb see the scope.
COMMENT ON VIEW host_listing_portfolios IS 'Listings per Airbnb host account per scrape date: the host''s Anchorage listing portfolio. Counts only listings inside the Municipality, so a host with 2 here and 40 elsewhere reads as 2 — their true portfolio is not recoverable from this database. No threshold marking a commercial host is stored.';
COMMENT ON COLUMN host_listing_portfolios.listings_active IS 'Listings held by this host that were live on scrape_date (seen within the retirement grace window ending that day).';
COMMENT ON COLUMN host_listing_portfolios.listings_ever_seen IS 'Distinct listings observed under this host on or before scrape_date, active or inactive.';
COMMENT ON VIEW listings_active_with_host IS 'listings_active plus the host''s name, tenure, and host_listing_portfolios counts as of the latest run. NULL when the host is unknown. Portfolio counts cover only listings inside the Municipality.';
`;

/** CityView's own row id for an archived registration's license, read from its `status_url`. */
export const CITYVIEW_LICENSE_ID_SQL = "nullif(regexp_extract(status_url, '[?&]licenseId=(\\d+)', 1), '')::INTEGER";

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

const REGISTRY_VIEWS_SQL = `
-- The latest license scrape that completed its writes. The registry is the
-- Short-Term Rentals licenses among the license pages, so this is the date
-- \`registrations\` is current to.
CREATE OR REPLACE VIEW latest_registry_date AS
SELECT max(scrape_date) AS scrape_date FROM muni_license_scrape_runs
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
-- parcel__property_type ('RESIDENTIAL', 'CONDO', ...) and
-- parcel__total_living_units are property_parcels' columns for parcel_id,
-- NULL when the license names no single parcel or the parcel scrape has not
-- seen it. The parcel__ prefix marks them as coming from property_parcels.
-- geocoded_* and community_council are the Muni geocoder's match for the
-- address (muni_address_geocodes), NULL when it has none or has not been
-- asked yet.
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
    pp.property_type AS parcel__property_type,
    pp.total_living_units AS parcel__total_living_units,
    g.matched_address AS geocoded_address,
    g.lat AS geocoded_lat,
    g.lng AS geocoded_lng,
    g.community_council
FROM latest l
JOIN read_dates d ON d.cityview_license_id = l.cityview_license_id
JOIN places p ON p.cityview_license_id = l.cityview_license_id
LEFT JOIN hidden_dates h ON h.cityview_license_id = l.cityview_license_id
LEFT JOIN latest_issuance i ON i.cityview_license_id = l.cityview_license_id
LEFT JOIN muni_address_geocodes g ON g.address = p.address
LEFT JOIN property_parcels pp ON pp.parcel_id = p.parcel_id
WHERE h.last_hidden_date IS NULL OR h.last_hidden_date < d.last_read_date;

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
-- archived layer. parcel_type is the license's parcel's property_type in
-- property_parcels when the parcel is there, else the archived layer's
-- ParcelType. The two vocabularies differ: property_parcels has the
-- appraisal grouping in upper case ('RESIDENTIAL', 'CONDO', 'APARTMENT',
-- 'COMMERCIAL', ...), the layer only 'Residential' and 'Commercial'.
-- submitted_date comes from the archived layer alone. Each is NULL when its
-- source has nothing.
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
        CASE WHEN pp.parcel_id IS NOT NULL THEN pp.property_type
             ELSE a.parcel_type END AS parcel_type,
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
    LEFT JOIN property_parcels pp ON pp.parcel_id = c.parcel_id
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
        a.parcel_type,
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
-- since the license scrape last read new license ids.
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

COMMENT ON VIEW latest_registry_date IS 'The latest license scrape that completed its writes (muni_license_scrape_runs with no error_summary).';
COMMENT ON VIEW licenses IS 'One row per CityView license with a visible page, of any type (Short-Term Rentals, Business, Alcohol): its latest page read, first_read_date and last_read_date. Licenses whose latest read found the id hidden are left out. is_active means the most recent issuance''s status is Active or Issued. parcel__property_type (RESIDENTIAL, CONDO, ...) and parcel__total_living_units are from property_parcels for parcel_id. geocoded_* and community_council are the Muni geocoder''s match for address.';
COMMENT ON VIEW registrations IS 'One row per STR registration: each STR Certificate number on a Short-Term Rentals license page, plus registrations only the archived registration layer holds. is_active means the STR Certificate''s status is Active; archive-only registrations are not active. geocoded_* and community_council are the license''s geocode, else the archived layer''s. parcel_type is property_parcels.property_type for the license''s parcel (RESIDENTIAL, CONDO, ...) when the parcel is there, else the archived layer''s ParcelType (Residential, Commercial); the two vocabularies differ. submitted_date comes from the archived layer.';
COMMENT ON VIEW listings_active_with_registration IS 'listings_active plus the Municipal registration matching registration_id. Registration columns are NULL when there is no match.';
`;

/**
 * When each upstream source was last read. One view over every source's run
 * log, so the viewer can show each source's date: a source whose workflow is
 * failing keeps its last good date while the others move on.
 */
const FRESHNESS_VIEWS_SQL = `
-- One row per upstream source, always present, over its runs that completed
-- their writes (no error_summary): last_success_date is the latest scrape_date
-- and last_success_finished_at the latest run_finished_at, both NULL when
-- the source has no such run.
CREATE OR REPLACE VIEW source_freshness AS
SELECT 'airbnb' AS source, max(scrape_date) AS last_success_date,
    max(run_finished_at) AS last_success_finished_at
FROM airbnb_scrape_runs WHERE error_summary IS NULL
UNION ALL
SELECT 'muni_licenses', max(scrape_date), max(run_finished_at)
FROM muni_license_scrape_runs WHERE error_summary IS NULL
UNION ALL
SELECT 'property_parcels', max(scrape_date), max(run_finished_at)
FROM property_parcel_scrape_runs WHERE error_summary IS NULL;

COMMENT ON VIEW source_freshness IS 'One row per upstream source (airbnb, muni_licenses, property_parcels): the latest date and finish time among its runs with no error_summary, NULL when it has none.';
`;

/**
 * `jitter_fits(pin_lat, pin_lng, lat, lng, tolerance_m := 0)`: whether
 * (`lat`, `lng`) can be the true location behind the jittered coordinate
 * (`pin_lat`, `pin_lng`). The same test as `jitterFits` in `utils/jitter.ts`.
 */
const MACROS_SQL = `
CREATE OR REPLACE MACRO jitter_fits(pin_lat, pin_lng, lat, lng, tolerance_m := 0) AS (
    abs(lat - pin_lat) BETWEEN ${JITTER_MIN_DEGREES} - tolerance_m / ${METERS_PER_DEGREE_LAT}
        AND ${JITTER_MAX_DEGREES} + tolerance_m / ${METERS_PER_DEGREE_LAT}
    AND abs(lng - pin_lng)
        BETWEEN ${JITTER_MIN_DEGREES} - tolerance_m / (${METERS_PER_DEGREE_LAT} * cos(radians(pin_lat)))
        AND ${JITTER_MAX_DEGREES} + tolerance_m / (${METERS_PER_DEGREE_LAT} * cos(radians(pin_lat)))
);
`;

/**
 * Views under names this file no longer creates. `CREATE OR REPLACE VIEW`
 * cannot remove one, so a published database would carry a renamed view's old
 * name forever, still answering queries from a definition nothing maintains.
 * Everything below is recreated straight after, so dropping it here is safe.
 */
const DROPPED_VIEWS_SQL = `
-- Renamed to host_listing_portfolios: a portfolio needs to say whose it is
-- and what it counts.
DROP VIEW IF EXISTS host_portfolios;
-- Replaced by licenses, which leaves out ids whose latest read is hidden.
DROP VIEW IF EXISTS license_pages_latest;
`;

/**
 * Every macro and view, in dependency order: `registrations` reads `licenses` and
 * `listings_active`.
 */
export function viewsSql(): string {
  const listingViews = LISTING_VIEWS_SQL.replaceAll('{grace}', String(RETIREMENT_GRACE_DAYS))
    .replaceAll('{hosting_start}', IMPLIED_HOSTING_START_SQL)
    .replace('{page_attrs}', PAGE_ATTRS_SQL)
    .replace('{version_key}', VERSION_KEY_SQL);
  return MACROS_SQL + DROPPED_VIEWS_SQL + listingViews + REGISTRY_VIEWS_SQL + FRESHNESS_VIEWS_SQL;
}
