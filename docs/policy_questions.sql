-- Queries for common policy questions. Run with:
--   duckdb data/anchorage_str.duckdb
-- or attach the published database read-only:
--   ATTACH 'anchorage_str.duckdb' AS str (READ_ONLY);
-- ============================================================
-- Q: How many listings had calendar data for a given night?
-- Every row here is a night that was on the listing's calendar when it was
-- read, available or not. It says the listing was on Airbnb that night, not
-- that anyone stayed. A listing with no row for a night is not a zero: it
-- had not been scraped yet, had retired, is past Airbnb's ~12-month window,
-- or its calendar was never read. Say "no calendar data".
-- Uses `calendar_current`, which excludes inactive listings' future nights.
-- ============================================================
SELECT
    night_date,
    count(DISTINCT listing_id) AS listings_with_calendar
FROM
    calendar_current
WHERE
    night_date BETWEEN CURRENT_DATE
    AND CURRENT_DATE + INTERVAL 90 DAY
GROUP BY
    ALL
ORDER BY
    night_date;

-- ============================================================
-- Q: How many are not available on a given night?
-- A past night keeps its last observed value, so this covers future
-- bookings and past occupancy alike.
-- Caveat: `available = false` means "not bookable", which is a guest booking
-- it and the host blocking it together. The calendar cannot tell them apart,
-- so these columns are named for what is observed, not for occupancy.
-- ============================================================
SELECT
    night_date,
    count(*) FILTER (
        WHERE
            NOT available
    ) AS not_available,
    count(*) FILTER (
        WHERE
            available
    ) AS available,
    count(*) AS listings_with_calendar,
    round(
        100.0 * count(*) FILTER (
            WHERE
                NOT available
        ) / count(*),
        1
    ) AS pct_not_available
FROM
    calendar_current -- swap in airbnb_calendar_status + a valid_from/valid_to filter
    -- to ask "as observed on date X"
GROUP BY
    ALL
ORDER BY
    night_date;

-- ============================================================
-- Q: How many distinct listings in Anchorage were active in the last year?
-- ============================================================
SELECT
    count(DISTINCT listing_id) AS distinct_listings_last_365_days
FROM
    airbnb_listing_observations
WHERE
    scrape_date >= CURRENT_DATE - INTERVAL 365 DAY;

-- Same, broken out by month, to see growth/decline over time:
SELECT
    date_trunc('month', scrape_date) AS MONTH,
    count(DISTINCT listing_id) AS distinct_listings_that_month
FROM
    airbnb_listing_observations
GROUP BY
    ALL
ORDER BY
    MONTH;

-- ============================================================
-- Q: How many listings are active, and how has that count trended?
-- ============================================================
SELECT
    scrape_date,
    listings_seen,
    listings_new,
    listings_retired
FROM
    airbnb_scrape_runs
ORDER BY
    scrape_date;

-- ============================================================
-- Q: What is a single listing's history?
-- `listings` has one row per version; `airbnb_listing_observations` has one row
-- per day the listing appeared in search.
-- ============================================================
-- SELECT * FROM listings WHERE listing_id = :id ORDER BY valid_from;
-- SELECT * FROM airbnb_listing_observations WHERE listing_id = :id ORDER BY scrape_date;
-- SELECT night_date, available, valid_from FROM airbnb_calendar_status
--   WHERE listing_id = :id ORDER BY night_date;
-- ============================================================
-- Q: What is the bedroom mix of active listings?
-- ============================================================
SELECT
    coalesce(bedrooms :: VARCHAR, 'studio/unknown') AS bedrooms,
    count(*) AS n_listings
FROM
    listings
WHERE
    is_active
GROUP BY
    ALL
ORDER BY
    bedrooms;

-- ============================================================
-- Q: Which STR parcels claim the owner's-primary-residence exemption?
-- Nearest-centroid match against the parcel database; check match_m, and
-- see the location_is_exact query below.
-- ============================================================
-- ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS parcels (READ_ONLY);
-- LOAD spatial;
-- WITH nearest AS (
--     SELECT
--         l.listing_id, l.name, l.url,
--         p.parcel_id, p.parcel_address, p.owner_name, p.exemption_6_type,
--         ST_Distance(
--             ST_Transform(ST_Point(l.location_lng, l.location_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true),
--             ST_Transform(ST_Point(p.centroid_lon, p.centroid_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true)
--         ) AS match_m,
--         row_number() OVER (PARTITION BY l.listing_id ORDER BY
--             ST_Distance(
--                 ST_Transform(ST_Point(l.location_lng, l.location_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true),
--                 ST_Transform(ST_Point(p.centroid_lon, p.centroid_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true)
--             )) AS rn
--     FROM listings l
--     JOIN parcels.parcels_current p ON p.tax_district = '4'
--     WHERE l.is_active
-- )
-- SELECT * FROM nearest
-- WHERE rn = 1 AND match_m < 60  -- roughly the same lot
--   AND exemption_6_type = 'OWNERS PRIMARY RESIDENCE'
-- ORDER BY match_m;
-- ============================================================
-- Q: How many listings show an exact location vs. a jittered one?
-- Parcel matching is only meaningful for exact locations.
-- NULL means the listing's page has never been read (page_seen_date IS NULL).
-- ============================================================
SELECT
    location_is_exact,
    count(*) AS listings,
    round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM
    listings
WHERE
    is_active
GROUP BY
    ALL
ORDER BY
    location_is_exact DESC NULLS LAST;

-- ============================================================
-- Q: Which listings don't display a municipal STR registration id?
-- AO 2025-115(S-2) requires the number in listings from 2026-07-31. Hosts
-- type it in, so a number is a claim of registration, not a verification.
-- ============================================================
SELECT
    listing_id,
    name,
    url,
    first_seen_date
FROM
    listings
WHERE
    is_active
    AND page_seen_date IS NOT NULL
    AND registration_id IS NULL
ORDER BY
    first_seen_date;

-- ============================================================
-- Q: When did hosts start publishing registration ids?
-- Counts listing versions that added a number, by the date first seen.
-- ============================================================
SELECT
    valid_from AS changed_on,
    count(*) AS listings_that_added_a_number
FROM
    listings a
WHERE
    registration_id IS NOT NULL
    AND NOT EXISTS (
        SELECT
            1
        FROM
            listings b
        WHERE
            b.listing_id = a.listing_id
            AND b.valid_to = a.valid_from
            AND b.registration_id IS NOT NULL
    )
GROUP BY
    ALL
ORDER BY
    changed_on;

-- ============================================================
-- Q: Which listings show a registration id the Muni hasn't published?
-- Either a typo, a lapsed registration, or one issued since the Muni's last
-- publish (registrations.published_at).
-- ============================================================
SELECT
    listing_id,
    name,
    url,
    registration_id
FROM
    listings_active_with_registration
WHERE
    registration_id IS NOT NULL
    AND NOT registration_found
ORDER BY
    registration_id;

-- ============================================================
-- Q: Which registration ids appear on several Airbnb listings?
-- Private rooms of one home, duplicate listings, or one id shown on several
-- units; compare the listings' names and coordinates.
-- ============================================================
SELECT
    registration_id,
    business_name,
    location,
    airbnb_listings_active
FROM
    registrations_active
WHERE
    airbnb_listings_active > 1
ORDER BY
    airbnb_listings_active DESC;

-- ============================================================
-- Q: How many active registrations have no Airbnb listing showing them?
-- They may be listed elsewhere (Vrbo, direct), listed without the number,
-- or not operating.
-- ============================================================
SELECT
    parcel_type,
    count(*) AS registrations,
    count(*) FILTER (WHERE airbnb_listings_active = 0) AS not_on_airbnb
FROM
    registrations_active
GROUP BY
    ALL
ORDER BY
    registrations DESC;

-- ============================================================
-- Q: How do registrants describe their business?
-- The license page's free-text description, as the licensee wrote it.
-- license_description is NULL until the page has been read.
-- ============================================================
SELECT
    registration_id,
    business_name,
    license_description
FROM
    registrations_active
WHERE
    license_description IS NOT NULL
ORDER BY
    registration_id;

-- ============================================================
-- Q: Which registered STR parcels claim the owner's-primary-residence
-- exemption? Joins on the license's parcel id, so no spatial match is needed.
-- ============================================================
-- ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS parcels (READ_ONLY);
-- SELECT r.registration_id, r.business_name, r.location, p.owner_name,
--        r.airbnb_listings_active
-- FROM registrations_active r
-- JOIN parcels.parcels_current p ON p.parcel_id = r.parcel_id
-- WHERE p.exemption_6_type = 'OWNERS PRIMARY RESIDENCE'
-- ORDER BY r.registration_id;

-- ============================================================
-- Q: Parcel match for listings with an exact location.
-- Run the ATTACH/LOAD lines from the parcel query above first.
-- ============================================================
-- SELECT l.listing_id, l.name, l.registration_id, p.parcel_id, p.parcel_address, p.owner_name
-- FROM listings l
-- JOIN parcels.parcels_current p ON p.tax_district = '4'
-- WHERE l.is_active AND l.location_is_exact
--   AND ST_Distance(
--         ST_Transform(ST_Point(l.location_lng, l.location_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true),
--         ST_Transform(ST_Point(p.centroid_lon, p.centroid_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true)
--       ) < 60;

-- ============================================================
-- Q: Which hosts operate the most active listings?
-- `host_id` is the primary host's account; a property manager running
-- listings for several owners appears as one host.
-- ============================================================
SELECT
    host_id,
    'https://www.airbnb.com/users/show/' || host_id AS host_url,
    count(*) AS current_listings,
    list(listing_id ORDER BY listing_id) AS listing_ids
FROM
    listings
WHERE
    is_active
    AND host_id IS NOT NULL
GROUP BY
    host_id
ORDER BY
    current_listings DESC
LIMIT
    25;

-- ============================================================
-- Q: How has the STR market grown over time?
-- Listings by the year they were first available on Airbnb, estimated as
-- the earlier of their first review and first_seen_date
-- (`first_available_date_est`). Caveats:
-- - The estimate is never early, only late: a listing exists before its
--   first review, often by months. A listing with no reviews before this
--   project first saw it counts as entering in the year collection began.
-- - Only listings seen since collection began are counted. Listings that
--   retired earlier are missing, so earlier years undercount the market of
--   that time. `cumulative_listings` counts entries, not active listings.
-- - Joining `airbnb_listing_first_reviews` drops listings whose reviews have not
--   been read yet, which would otherwise count as new.
-- ============================================================
WITH per_listing AS (
    SELECT
        listing_id,
        any_value(first_available_date_est) AS first_available_date_est
    FROM
        listings
        JOIN airbnb_listing_first_reviews USING (listing_id)
    GROUP BY
        listing_id
),
per_year AS (
    SELECT
        date_part('year', first_available_date_est) AS year_first_available,
        count(*) AS listings
    FROM
        per_listing
    GROUP BY
        ALL
)
SELECT
    year_first_available,
    listings,
    sum(listings) OVER (
        ORDER BY
            year_first_available
    ) AS cumulative_listings
FROM
    per_year
ORDER BY
    year_first_available;

-- ============================================================
-- Q: What share of listings are whole homes, and how has it changed?
-- A whole home rented as an STR is off the long-term market; a private or
-- shared room usually is not. Counts each day's observed listings at the
-- listing type of the version covering that day. `listing_type` is Airbnb's text
-- ('Entire home/apt', 'Private room', 'Shared room', 'Hotel room'), NULL for
-- listings whose page was never read.
-- ============================================================
SELECT
    o.scrape_date,
    count(l.listing_type) AS listings_with_listing_type,
    count(*) FILTER (WHERE l.listing_type = 'Entire home/apt') AS entire_homes,
    round(entire_homes / listings_with_listing_type, 3) AS entire_home_share
FROM
    airbnb_listing_observations o
    JOIN listings l ON l.listing_id = o.listing_id
    AND o.scrape_date >= l.valid_from
    AND (l.valid_to IS NULL OR o.scrape_date < l.valid_to)
GROUP BY
    o.scrape_date
ORDER BY
    o.scrape_date;

-- ============================================================
-- Q: Which listings changed listing type, e.g. a whole cabin now rented as
-- private rooms?
-- ============================================================
SELECT
    listing_id,
    url,
    prev_listing_type,
    listing_type,
    valid_from AS changed_on
FROM (
    SELECT
        *,
        lag(listing_type) OVER (PARTITION BY listing_id ORDER BY valid_from) AS prev_listing_type
    FROM listings
)
WHERE
    prev_listing_type IS DISTINCT FROM listing_type
    AND prev_listing_type IS NOT NULL
ORDER BY
    changed_on DESC;

-- ============================================================
-- Q: What do active whole-home listings sleep, and what do they ask per night?
-- `bedrooms` is Airbnb's text ('2 bedrooms', 'Studio'). The nightly rate is
-- each listing's latest quote divided by its nights: the asking price of its
-- earliest bookable stay, so it leans toward nights that were still available.
-- ============================================================
WITH latest_quote AS (
    SELECT
        listing_id,
        quote_total / quote_nights AS quoted_nightly
    FROM
        airbnb_listing_observations
    WHERE
        quote_total IS NOT NULL
    QUALIFY
        row_number() OVER (PARTITION BY listing_id ORDER BY scrape_date DESC) = 1
)
SELECT
    coalesce(l.bedrooms, 'Not listed') AS bedrooms_line,
    count(*) AS entire_homes,
    sum(l.guest_capacity) AS total_guest_capacity,
    round(median(q.quoted_nightly)) AS median_quoted_nightly
FROM
    listings l
    LEFT JOIN latest_quote q USING (listing_id)
WHERE
    l.is_active
    AND l.listing_type = 'Entire home/apt'
GROUP BY
    l.bedrooms
ORDER BY
    try_cast(regexp_extract(l.bedrooms, '^\d+') AS INTEGER) NULLS FIRST,
    l.bedrooms;

-- ============================================================
-- Q: Who are the hosts, and how long have they hosted?
-- `name` is Airbnb's display name (a first name or a business name).
-- `hosting_started_on` can be up to a month late; see README.
-- ============================================================
SELECT
    host_id,
    name,
    hosting_started_year,
    years_hosting,
    about
FROM
    hosts
WHERE
    is_active
ORDER BY
    hosting_started_on;

-- ============================================================
-- Host listing portfolios. `host_listing_portfolios` stores counts only; the
-- cutoffs below are choices, swept rather than fixed.
-- `listings` is every listing on the host's Airbnb profile, wherever it is:
-- how big the host is. `listings_in_muni` is how many of those are active
-- here: the listings they run in Anchorage, which the shares below weight
-- by. A `host_id` is an Airbnb account, so a property manager's account can
-- list for many owners. Listings with no known host, and hosts whose profile
-- hasn't been read, are left out.
-- ============================================================
-- Q: How big are the hosts running Anchorage's listings?
SELECT
    listings AS listings_per_host,
    count(*) AS hosts,
    sum(listings_in_muni) AS listings_here,
    round(100.0 * sum(listings_in_muni) / sum(sum(listings_in_muni)) OVER (), 1) AS pct_of_attributed_listings
FROM
    host_listing_portfolios
WHERE
    scrape_date = (SELECT scrape_date FROM latest_scrape_date)
    AND listings_in_muni > 0
    AND listings IS NOT NULL
GROUP BY
    ALL
ORDER BY
    listings_per_host;

-- ============================================================
-- Q: What share of active listings here is run by hosts with N or more listings?
-- ============================================================
WITH now AS (
    SELECT
        listings,
        listings_in_muni
    FROM
        host_listing_portfolios
    WHERE
        scrape_date = (SELECT scrape_date FROM latest_scrape_date)
        AND listings_in_muni > 0
        AND listings IS NOT NULL
),
cutoffs AS (
    SELECT unnest([1, 2, 3, 5, 10, 20, 100]) AS n
)
SELECT
    c.n AS min_listings,
    count(*) FILTER (WHERE now.listings >= c.n) AS hosts,
    coalesce(sum(now.listings_in_muni) FILTER (WHERE now.listings >= c.n), 0) AS listings_here,
    round(
        100.0 * coalesce(sum(now.listings_in_muni) FILTER (WHERE now.listings >= c.n), 0)
        / sum(now.listings_in_muni),
        1
    ) AS pct_of_attributed_listings
FROM
    cutoffs c
    CROSS JOIN now
GROUP BY
    c.n
ORDER BY
    c.n;

-- ============================================================
-- Q: How has that concentration moved over the observed period?
-- Dates before the profile-listings pass began have no host sizes.
-- ============================================================
SELECT
    scrape_date,
    count(*) FILTER (WHERE listings_in_muni > 0) AS hosts_with_listings_here,
    sum(listings_in_muni) AS attributed_listings_here,
    round(100.0 * sum(listings_in_muni) FILTER (WHERE listings >= 2) / nullif(sum(listings_in_muni), 0), 1) AS pct_run_by_2_plus,
    round(100.0 * sum(listings_in_muni) FILTER (WHERE listings >= 5) / nullif(sum(listings_in_muni), 0), 1) AS pct_run_by_5_plus,
    round(100.0 * sum(listings_in_muni) FILTER (WHERE listings >= 10) / nullif(sum(listings_in_muni), 0), 1) AS pct_run_by_10_plus
FROM
    host_listing_portfolios
WHERE
    listings IS NOT NULL
GROUP BY
    ALL
ORDER BY
    scrape_date;

-- ============================================================
-- Q: Which hosts run mostly outside the Municipality?
-- Roughly: the profile drops a deactivated listing the same day, while
-- `listings_in_muni` keeps it through the retirement grace period.
-- ============================================================
SELECT
    host_id,
    listings,
    listings_in_muni,
    listings - listings_in_muni AS listings_elsewhere_approx,
    listings_read_date
FROM
    host_listing_portfolios
WHERE
    scrape_date = (SELECT scrape_date FROM latest_scrape_date)
    AND listings_in_muni > 0
    AND listings IS NOT NULL
ORDER BY
    listings_elsewhere_approx DESC,
    listings DESC
LIMIT
    25;

-- Hosts who grew the most since first observed.
SELECT
    host_id,
    min(scrape_date) FILTER (WHERE listings IS NOT NULL) AS first_read,
    arg_min(listings, scrape_date) FILTER (WHERE listings IS NOT NULL) AS listings_at_first_read,
    arg_max(listings, scrape_date) FILTER (WHERE listings IS NOT NULL) AS listings_now
FROM
    host_listing_portfolios
GROUP BY
    host_id
HAVING
    listings_now IS NOT NULL
ORDER BY
    listings_now - listings_at_first_read DESC,
    listings_now DESC
LIMIT
    25;

-- ============================================================
-- Q: Is this Girdwood listing part of a large portfolio?
-- NULL host columns mean the host is unknown, or their profile unread; not
-- a portfolio of one.
-- ============================================================
SELECT
    listing_id,
    name,
    url,
    host_name,
    host_years_hosting,
    host_listings
FROM
    listings_active_with_host
WHERE
    location_subtitle ILIKE 'Girdwood%'
ORDER BY
    host_listings DESC NULLS LAST,
    host_id;
