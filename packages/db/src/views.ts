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
 * `registrations` has one row per registration with its latest license page,
 * and `listings_current_with_registration` joins Airbnb listings to it on the
 * registration number. Cleaning (the `'None'` business name, the no-match
 * placeholder point) happens in the views, so the raw tables can always be
 * re-derived.
 *
 * The SQL here is what creates the views: they use DuckDB syntax drizzle-kit
 * cannot express, and recreating them on connect applies a change without a
 * migration. `viewSchema.ts` declares the columns that come out, for whoever
 * queries them; `connect` checks the two against each other, so a change here
 * that adds, drops or retypes a column has to be carried over there.
 */

import { NO_MATCH_GEOCODED_ADDRESS } from '@anchorage-str-db/scraper-muni-str/registrationLayers';

/**
 * Days a listing may be absent from search before `listings.is_current` goes
 * false. Search occasionally omits a listing for a day.
 */
export const RETIREMENT_GRACE_DAYS = 5;

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
 * doesn't open a version. `page` holds the listing-page fields, so a room
 * changing hands, converting from a whole home to a rented room, or changing
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
    'str_registration_id': str_registration_id,
    'host_id': host_id,
    'room_type': room_type,
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
-- it is current. A listing is current if seen within RETIREMENT_GRACE_DAYS
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
    ) - INTERVAL {grace} DAY AS is_current
FROM airbnb_listing_observations
GROUP BY listing_id;

-- SCD2 versions. A version runs from the first day an attribute set was
-- observed until the next distinct set appears.
CREATE OR REPLACE VIEW listing_versions AS
WITH observed AS (
    SELECT
        * EXCLUDE (
            location_is_exact, location_exact_address, location_subtitle,
            location_verified, str_registration_id, host_id,
            room_type, guest_capacity, beds, bedrooms, bathrooms
        ),
        -- NULL when the page fetch failed, so the carry-forward skips it.
        -- Carrying the whole struct keeps "read the page, no registration
        -- number" (a struct holding a NULL) distinct from "page not read"
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
    page_attrs.str_registration_id AS str_registration_id,
    page_attrs.host_id AS host_id,
    page_attrs.room_type AS room_type,
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
    v.room_type,
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
    v.str_registration_id,
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
    v.valid_to IS NULL AND a.is_current AS is_current
FROM listing_versions v
JOIN listing_activity a USING (listing_id)
LEFT JOIN airbnb_listing_first_reviews r USING (listing_id);

CREATE OR REPLACE VIEW listings_current AS
SELECT * FROM listings WHERE is_current;

-- Each listing's most recent photo set.
CREATE OR REPLACE VIEW listing_photos_current AS
SELECT
    listing_id,
    photo_urls,
    len(photo_urls)::INTEGER AS photo_count,
    valid_from AS photos_valid_from
FROM airbnb_listing_photos
QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY valid_from DESC) = 1;

-- Current calendar rows, minus the future nights of retired listings.
--
-- A retired listing's calendar is no longer fetched, so its future nights
-- stay is_current for up to twelve months. Nights up to its last_seen_date
-- are real observations and are kept.
CREATE OR REPLACE VIEW calendar_current AS
SELECT c.*
FROM airbnb_calendar_status c
JOIN listing_activity a USING (listing_id)
WHERE c.is_current
  AND (a.is_current OR c.night_date <= a.last_seen_date);

-- Per host: first and last seen, last card read, and whether current, on
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
    ) - INTERVAL {grace} DAY AS is_current
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

-- The host dimension. Join to \`listings\` on host_id; filter \`is_current\`
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
    v.valid_to IS NULL AND a.is_current AS is_current
FROM host_versions v
JOIN host_activity a USING (host_id);

-- Listings per host per completed run date. Counts only: no threshold or
-- owner/operator label is stored; that line is drawn downstream.
--
-- listings_live       listings held by the host that were live on
--                     scrape_date: the \`listing_activity.is_current\` rule
--                     evaluated as of that date.
-- listings_ever_seen  distinct listings observed under the host on or before
--                     scrape_date, live or not.
--
-- A row exists for every run date from the host's first observation on, so
-- a portfolio winding down reads as zeros rather than missing rows. A
-- listing's host is carried forward past failed page fetches as in
-- \`listing_versions\`, so the latest date agrees with
-- \`listings_current.host_id\`. A listing whose page was never read has no
-- known host and is counted under nobody.
--
-- Only listings in the Anchorage search area are counted, not a host's
-- listings elsewhere.
CREATE OR REPLACE VIEW host_portfolios AS
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
    SELECT host_id, scrape_date, count(*) AS listings_live
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
    coalesce(l.listings_live, 0)::INTEGER AS listings_live,
    sum(coalesce(n.listings_new, 0)) OVER (
        PARTITION BY p.host_id ORDER BY p.scrape_date
    )::INTEGER AS listings_ever_seen
FROM panel p
LEFT JOIN live_counts l USING (host_id, scrape_date)
LEFT JOIN newly_seen n USING (host_id, scrape_date);

-- \`listings_current\` plus the owning host's profile and portfolio as of the
-- latest run, so "is this Girdwood room part of a large portfolio?" needs no
-- join. The host columns are NULL when the host is unknown.
CREATE OR REPLACE VIEW listings_current_with_host AS
SELECT
    l.*,
    h.name AS host_name,
    h.years_hosting AS host_years_hosting,
    h.hosting_started_on AS host_hosting_started_on,
    p.listings_live AS host_listings_live,
    p.listings_ever_seen AS host_listings_ever_seen
FROM listings_current l
LEFT JOIN hosts h
  ON h.host_id = l.host_id AND h.valid_to IS NULL
LEFT JOIN host_portfolios p
  ON p.host_id = l.host_id
 AND p.scrape_date = (SELECT scrape_date FROM latest_scrape_date);

-- Stored in the file, so readers of the published .duckdb see the scope.
COMMENT ON VIEW host_portfolios IS 'Listings per Airbnb host account per scrape date. Counts only listings in the Anchorage search area, not a host''s listings elsewhere. No owner/operator threshold is stored.';
COMMENT ON COLUMN host_portfolios.listings_live IS 'Listings held by this host that were live on scrape_date (seen within the retirement grace window ending that day).';
COMMENT ON COLUMN host_portfolios.listings_ever_seen IS 'Distinct listings observed under this host on or before scrape_date, live or retired.';
COMMENT ON VIEW listings_current_with_host IS 'listings_current plus the host''s name, tenure, and host_portfolios counts as of the latest run. NULL when the host is unknown. Portfolio counts cover only the Anchorage search area.';
`;

/** A registration's CityView licenseId, read from its `status_url`. */
export const LICENSE_ID_SQL = "nullif(regexp_extract(status_url, '[?&]licenseId=(\\d+)', 1), '')::INTEGER";

const REGISTRY_VIEWS_SQL = `
-- The latest registry run that completed its writes.
CREATE OR REPLACE VIEW latest_registry_date AS
SELECT max(scrape_date) AS scrape_date FROM muni_str_registry_runs
WHERE registrations_seen IS NOT NULL;

CREATE OR REPLACE VIEW license_pages_latest AS
SELECT * FROM muni_license_page_reads
QUALIFY row_number() OVER (PARTITION BY license_id ORDER BY scrape_date DESC) = 1;

-- One row per registration ever published, with its latest published fields
-- and latest license page. A registration is current if it was in the
-- latest registry run's layer, which lists only active registrations.
CREATE OR REPLACE VIEW registrations AS
WITH activity AS (
    SELECT
        registration_number,
        min(scrape_date) AS first_seen_date,
        max(scrape_date) AS last_seen_date
    FROM muni_str_registration_observations
    GROUP BY registration_number
),
latest AS (
    SELECT *, ${LICENSE_ID_SQL} AS license_id
    FROM muni_str_registration_observations
    QUALIFY row_number() OVER (PARTITION BY registration_number ORDER BY scrape_date DESC) = 1
),
airbnb AS (
    SELECT str_registration_id AS registration_number, count(*)::INTEGER AS listings
    FROM listings_current
    WHERE str_registration_id IS NOT NULL
    GROUP BY str_registration_id
)
SELECT
    o.registration_number,
    o.application_number,
    o.license_id,
    o.status,
    o.submitted_date,
    o.issued_date,
    o.expires_date,
    nullif(o.business_name, 'None') AS business_name,
    o.location,
    o.community_council,
    o.parcel_type,
    o.geocoded_address,
    -- NULL where the geocoder found no match, instead of its placeholder point.
    CASE WHEN o.geocoded_address IS DISTINCT FROM '${NO_MATCH_GEOCODED_ADDRESS}'
         THEN o.geocoded_lat END AS geocoded_lat,
    CASE WHEN o.geocoded_address IS DISTINCT FROM '${NO_MATCH_GEOCODED_ADDRESS}'
         THEN o.geocoded_lng END AS geocoded_lng,
    o.status_url,
    o.published_at,
    p.scrape_date AS license_read_date,
    p.status AS license_status,
    p.license_type,
    p.description AS license_description,
    p.business_name AS license_business_name,
    -- Parcel ids linked to property records. A parcel id typed as text has no
    -- label and is not included (license 13990).
    [l.value FOR l IN p.locations IF l.label = 'Property'] AS license_parcel_ids,
    [l.value FOR l IN p.locations IF l.label = 'Address'] AS license_addresses,
    -- The parcel id when the license lists exactly one; join to
    -- anchorage-property's parcels on it.
    CASE WHEN len([l FOR l IN p.locations IF l.label = 'Property']) = 1
         THEN [l.value FOR l IN p.locations IF l.label = 'Property'][1] END AS parcel_id,
    p.issuances AS license_issuances,
    coalesce(b.listings, 0) AS airbnb_listings_current,
    a.first_seen_date,
    a.last_seen_date,
    a.last_seen_date = (SELECT scrape_date FROM latest_registry_date) AS is_current
FROM latest o
JOIN activity a USING (registration_number)
LEFT JOIN license_pages_latest p ON p.license_id = o.license_id
LEFT JOIN airbnb b USING (registration_number);

CREATE OR REPLACE VIEW registrations_current AS
SELECT * FROM registrations WHERE is_current;

-- \`listings_current\` plus the registration its page cites. The registration
-- columns are NULL when the listing shows no number or the number is not in
-- the registry, which includes numbers issued since the layer's last publish.
CREATE OR REPLACE VIEW listings_current_with_registration AS
SELECT
    l.*,
    r.registration_number IS NOT NULL AS registration_found,
    r.is_current AS registration_is_current,
    r.business_name AS registration_business_name,
    r.location AS registration_location,
    r.parcel_id AS registration_parcel_id,
    r.parcel_type AS registration_parcel_type,
    r.community_council AS registration_community_council,
    r.issued_date AS registration_issued_date,
    r.expires_date AS registration_expires_date,
    r.license_description AS registration_license_description,
    r.airbnb_listings_current AS registration_airbnb_listings_current
FROM listings_current l
LEFT JOIN registrations r ON r.registration_number = l.str_registration_id;

COMMENT ON VIEW registrations IS 'One row per STR registration the Municipal Clerk has published, with its latest license page. is_current means it was in the latest registry run; the Muni publishes only active registrations.';
COMMENT ON VIEW listings_current_with_registration IS 'listings_current plus the Municipal registration matching str_registration_id. Registration columns are NULL when there is no match.';
`;

/** Every view, in dependency order: `registrations` reads `listings_current`. */
export function viewsSql(): string {
  const listingViews = LISTING_VIEWS_SQL.replaceAll('{grace}', String(RETIREMENT_GRACE_DAYS))
    .replaceAll('{hosting_start}', IMPLIED_HOSTING_START_SQL)
    .replace('{page_attrs}', PAGE_ATTRS_SQL)
    .replace('{version_key}', VERSION_KEY_SQL);
  return listingViews + REGISTRY_VIEWS_SQL;
}
