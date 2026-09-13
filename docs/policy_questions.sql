-- Queries for common policy questions. Run with:
--   duckdb data/anchorage_str.duckdb
-- or attach the published database read-only:
--   ATTACH 'anchorage_str.duckdb' AS str (READ_ONLY);
-- ============================================================
-- Q: How many listings are operating on a given night?
-- "Operating" = the night is in its calendar, booked or open.
-- Uses `calendar_current`, which excludes retired listings' future nights.
-- ============================================================
SELECT
    night_date,
    count(DISTINCT listing_id) AS listings_operating
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
-- Q: How many are booked (vs. open/vacant) on a given night?
-- A past night keeps its last observed value, so this covers future
-- bookings and past occupancy alike.
-- Caveat: `available = false` means "not bookable", which includes nights
-- the host blocked. The calendar cannot distinguish the two.
-- ============================================================
SELECT
    night_date,
    count(*) FILTER (
        WHERE
            NOT available
    ) AS booked,
    count(*) FILTER (
        WHERE
            available
    ) AS vacant,
    count(*) AS total_operating,
    round(
        100.0 * count(*) FILTER (
            WHERE
                NOT available
        ) / count(*),
        1
    ) AS pct_booked
FROM
    calendar_current -- swap in calendar_status + a valid_from/valid_to filter
    -- to ask "as observed on date X"
GROUP BY
    ALL
ORDER BY
    night_date;

-- ============================================================
-- Q: How many distinct homes in Anchorage operated as an STR in the last year?
-- ============================================================
SELECT
    count(DISTINCT listing_id) AS distinct_strs_last_365_days
FROM
    listing_observations
WHERE
    scrape_date >= CURRENT_DATE - INTERVAL 365 DAY;

-- Same, broken out by month, to see growth/decline over time:
SELECT
    date_trunc('month', scrape_date) AS MONTH,
    count(DISTINCT listing_id) AS distinct_strs_that_month
FROM
    listing_observations
GROUP BY
    ALL
ORDER BY
    MONTH;

-- ============================================================
-- Q: How many STRs are currently active, and how has that count trended?
-- ============================================================
SELECT
    scrape_date,
    listings_seen,
    listings_new,
    listings_retired
FROM
    scrape_runs
ORDER BY
    scrape_date;

-- ============================================================
-- Q: What is a single listing's history?
-- `listings` has one row per version; `listing_observations` has one row
-- per day the listing appeared in search.
-- ============================================================
-- SELECT * FROM listings WHERE listing_id = :id ORDER BY valid_from;
-- SELECT * FROM listing_observations WHERE listing_id = :id ORDER BY scrape_date;
-- SELECT night_date, available, valid_from FROM calendar_status
--   WHERE listing_id = :id ORDER BY night_date;
-- ============================================================
-- Q: What is the bedroom mix of current listings?
-- ============================================================
SELECT
    coalesce(bedrooms :: VARCHAR, 'studio/unknown') AS bedrooms,
    count(*) AS n_listings
FROM
    listings
WHERE
    is_current
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
--     WHERE l.is_current
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
    is_current
GROUP BY
    ALL
ORDER BY
    location_is_exact DESC NULLS LAST;

-- ============================================================
-- Q: Which listings don't display a municipal STR registration number?
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
    is_current
    AND page_seen_date IS NOT NULL
    AND str_registration_id IS NULL
ORDER BY
    first_seen_date;

-- ============================================================
-- Q: When did hosts start publishing registration numbers?
-- Counts listing versions that added a number, by the date first seen.
-- ============================================================
SELECT
    valid_from AS changed_on,
    count(*) AS listings_that_added_a_number
FROM
    listings a
WHERE
    str_registration_id IS NOT NULL
    AND NOT EXISTS (
        SELECT
            1
        FROM
            listings b
        WHERE
            b.listing_id = a.listing_id
            AND b.valid_to = a.valid_from
            AND b.str_registration_id IS NOT NULL
    )
GROUP BY
    ALL
ORDER BY
    changed_on;

-- ============================================================
-- Q: Parcel match for listings with an exact location.
-- Run the ATTACH/LOAD lines from the parcel query above first.
-- ============================================================
-- SELECT l.listing_id, l.name, l.str_registration_id, p.parcel_id, p.parcel_address, p.owner_name
-- FROM listings l
-- JOIN parcels.parcels_current p ON p.tax_district = '4'
-- WHERE l.is_current AND l.location_is_exact
--   AND ST_Distance(
--         ST_Transform(ST_Point(l.location_lng, l.location_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true),
--         ST_Transform(ST_Point(p.centroid_lon, p.centroid_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true)
--       ) < 60;

-- ============================================================
-- Q: Which hosts operate the most current listings?
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
    is_current
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
-- - The estimate is never early, only late: a room is listed before its
--   first review, often by months. A room with no reviews before this
--   project first saw it counts as entering in the year collection began.
-- - Only rooms seen since collection began are counted. Rooms that left
--   Airbnb earlier are missing, so earlier years undercount the market of
--   that time. `cumulative_listings` counts entries, not rooms operating.
-- - Joining `listing_first_reviews` drops listings whose reviews have not
--   been read yet, which would otherwise count as new.
-- ============================================================
WITH per_listing AS (
    SELECT
        listing_id,
        any_value(first_available_date_est) AS first_available_date_est
    FROM
        listings
        JOIN listing_first_reviews USING (listing_id)
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
-- room type of the version covering that day. `room_type` is Airbnb's text
-- ('Entire home/apt', 'Private room', 'Shared room', 'Hotel room'), NULL for
-- listings whose page was never read.
-- ============================================================
SELECT
    o.scrape_date,
    count(l.room_type) AS listings_with_room_type,
    count(*) FILTER (WHERE l.room_type = 'Entire home/apt') AS entire_homes,
    round(entire_homes / listings_with_room_type, 3) AS entire_home_share
FROM
    listing_observations o
    JOIN listings l ON l.listing_id = o.listing_id
    AND o.scrape_date >= l.valid_from
    AND (l.valid_to IS NULL OR o.scrape_date < l.valid_to)
GROUP BY
    o.scrape_date
ORDER BY
    o.scrape_date;

-- ============================================================
-- Q: Which listings changed room type, e.g. a whole cabin now rented by
-- the room?
-- ============================================================
SELECT
    listing_id,
    url,
    prev_room_type,
    room_type,
    valid_from AS changed_on
FROM (
    SELECT
        *,
        lag(room_type) OVER (PARTITION BY listing_id ORDER BY valid_from) AS prev_room_type
    FROM listings
)
WHERE
    prev_room_type IS DISTINCT FROM room_type
    AND prev_room_type IS NOT NULL
ORDER BY
    changed_on DESC;

-- ============================================================
-- Q: What do current whole-home STRs sleep, and what do they ask per night?
-- `bedrooms` is Airbnb's text ('2 bedrooms', 'Studio'). The nightly rate is
-- each listing's latest quote divided by its nights: the asking price of its
-- earliest open stay, so it leans toward nights that were still unbooked.
-- ============================================================
WITH latest_quote AS (
    SELECT
        listing_id,
        quote_total / quote_nights AS quoted_nightly
    FROM
        listing_observations
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
    l.is_current
    AND l.room_type = 'Entire home/apt'
GROUP BY
    l.bedrooms
ORDER BY
    try_cast(regexp_extract(l.bedrooms, '^\d+') AS INTEGER) NULLS FIRST,
    l.bedrooms;

-- ============================================================
-- Q: How many listings display a municipal registration number?
-- Anchorage has required one in every listing since 2026-07-31
-- (AO 2025-115(S-2)). This needs no registry data: the scraper reads the
-- number off each listing page.
-- ============================================================
SELECT
    count(*) AS current_listings,
    count(str_registration_id) AS showing_a_number,
    round(100.0 * count(str_registration_id) / count(*), 1) AS pct
FROM
    listings
WHERE
    is_current;

-- ============================================================
-- Q: How did compliance change over time?
-- The registration number is part of the listing version key, so a host
-- adding or removing one opens a new version and the archive already holds
-- the adoption curve. Reads the version intervals, so it is correct for
-- days with no run.
-- ============================================================
WITH days AS (
    SELECT UNNEST(range(
        (SELECT min(valid_from) FROM listings),
        (SELECT max(scrape_date) FROM listing_observations) + INTERVAL 1 DAY,
        INTERVAL 1 DAY
    ))::DATE AS day
)
SELECT
    d.day,
    count(*) AS current_listings,
    count(*) FILTER (WHERE l.str_registration_id IS NOT NULL) AS showing_a_number
FROM
    days d
    JOIN listings l
      ON l.valid_from <= d.day
     AND (l.valid_to IS NULL OR l.valid_to > d.day)
GROUP BY
    ALL
ORDER BY
    d.day;

-- ============================================================
-- Q: How much of the Airbnb market and the registry actually match?
-- Needs the registry scrape (packages/registry). `match_kind` splits every
-- current listing and registration four ways; see
-- docs/proposals/muni-registry-integration.md.
-- ============================================================
SELECT
    *
FROM
    listing_registration_coverage
ORDER BY
    match_kind;

-- ============================================================
-- Q: Which listings advertise a number the registry does not hold?
-- A typo, a registration that has lapsed, or an invented number. The
-- enforcement list, and the reason the join is not made looser: a wrong
-- digit should surface here rather than be silently corrected into a match.
-- ============================================================
SELECT
    listing_id,
    listing_name,
    listing_registration_text,
    host_id,
    listing_lat,
    listing_lng,
    listing_location_is_exact
FROM
    listing_registration_matches
WHERE
    match_kind = 'listing_number_unmatched'
ORDER BY
    listing_id;

-- ============================================================
-- Q: Which registered properties are not on Airbnb?
-- Vrbo, booked direct, not advertised, or missed by the search. The
-- registry's own address is the only street address this database holds.
-- ============================================================
SELECT
    registration_id,
    registration_status,
    registration_address,
    parcel_id,
    operator_name,
    issued_date,
    expires_date
FROM
    listing_registration_matches
WHERE
    match_kind = 'registration_only'
ORDER BY
    registration_address;

-- ============================================================
-- Q: Who operates the most registered rentals?
-- The registry names an operator per registration, which the Airbnb side
-- cannot: `host_id` is an account, and one operator can hold several.
-- ============================================================
SELECT
    operator_name,
    count(*) AS registrations,
    count(DISTINCT parcel_id) AS parcels,
    min(issued_date) AS first_registered
FROM
    str_registrations_current
WHERE
    operator_name IS NOT NULL
GROUP BY
    ALL
HAVING
    count(*) > 1
ORDER BY
    registrations DESC;

-- ============================================================
-- Q: What happened to a listing after its registration lapsed?
-- Both sides are stored as version intervals, so this is a join of two
-- histories rather than a snapshot comparison.
-- ============================================================
SELECT
    r.registration_id,
    r.status AS registration_status,
    r.valid_from AS status_from,
    r.valid_to AS status_to,
    r.removed_date,
    l.listing_id,
    l.last_seen_date AS listing_last_seen,
    l.is_current AS listing_still_listed
FROM
    str_registrations r
    JOIN listings l
      ON registration_key(l.str_registration_id) = r.registration_id
WHERE
    r.status ILIKE '%expire%'
    OR r.status ILIKE '%revok%'
    OR r.removed_date IS NOT NULL
ORDER BY
    r.registration_id,
    r.valid_from;
