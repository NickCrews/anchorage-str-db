-- Ready-made answers to the questions GBOS actually asks. Run with:
--   duckdb data/anchorage_str.duckdb
-- or attach the published database read-only from anywhere:
--   ATTACH 'anchorage_str.duckdb' AS str (READ_ONLY);
-- ============================================================
-- Q: How many houses are up (operating as an STR) on a given night?
-- "Up" = had that night in its calendar at all, whether booked or open.
-- Read `calendar_current`, not `calendar_status`: when a listing is retired
-- we stop fetching its calendar, so its forward nights freeze in place and
-- the raw table keeps reporting them as current for up to twelve months.
-- The view drops those while keeping the nights a retired listing really
-- was observed operating for.
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
-- Once night_date is in the past, calendar_status naturally freezes at the
-- last value we ever observed for it (Airbnb stops returning past dates in
-- the forward-looking calendar) — so this same query works for future
-- nights (the current booking pipeline) and past nights (realized
-- occupancy) without special-casing.
-- Caveat: `available = false` means "not bookable" — it conflates real
-- guest bookings with nights a host manually blocked (maintenance,
-- personal use). There's no way to tell the two apart from the calendar
-- alone; Inside Airbnb's methodology has the same limitation.
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
-- Q: What does a single listing's history look like — name/size changes,
-- and a year of night-by-night status?
-- `listings` is a view over `listing_observations`, which holds the raw
-- row-per-day if you want the unversioned truth (including the days a
-- listing was missing from search entirely).
-- ============================================================
-- SELECT * FROM listings WHERE listing_id = :id ORDER BY valid_from;
-- SELECT * FROM listing_observations WHERE listing_id = :id ORDER BY scrape_date;
-- SELECT night_date, available, valid_from FROM calendar_status
--   WHERE listing_id = :id ORDER BY night_date;
-- ============================================================
-- Q: Bedroom-size mix of Anchorage's STR inventory right now (a proxy for
-- how much housing stock — studios vs. family-sized homes — is tied up).
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
-- Cross-reference with the parcel database: which specific parcels are running
-- STRs, and are any of them claiming the owner's-primary-residence
-- exemption while also operating full-time as a short-term rental?
-- Nearest-centroid match, not exact — check match_m before trusting a row.
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
-- WHERE rn = 1 AND match_m < 60  -- ~60m: same lot, allowing GPS/geocoding slop
--   AND exemption_6_type = 'OWNERS PRIMARY RESIDENCE'
-- ORDER BY match_m;
-- ============================================================
-- Q: Which listings publish their *real* location, and which are fuzzed?
-- Airbnb jitters the map pin for listings whose host hasn't opted into
-- showing the exact spot, and the search response never says which case a
-- coordinate is. The listing page does, via `isExactLocation`, which the
-- daily run records onto the listing itself.
-- The parcel-matching query above is only trustworthy for the exact rows;
-- for the fuzzed ones the nearest parcel is a coincidence, not an answer.
-- `page_seen_date IS NULL` means we've never read that listing's page —
-- not that its location is unknown to Airbnb. It is derived as the last
-- scrape_date where `listing_observations.page_fetch_ok`.
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
-- AO 2025-115(S-2) requires registration by 2026-07-30 and the number to
-- appear in the listing from 2026-07-31. Hosts enter it free-text, so a
-- present number means "claims to be registered," not "is registered" —
-- confirming it against the Clerk's registry is a separate step.
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
-- The SCD2 history makes the display requirement's rollout visible: each
-- row is a listing-version whose registration number differs from the one
-- before it, dated to the run that first saw the change.
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
-- Q: Parcel match, restricted to listings whose coordinate is real.
-- Same shape as the nearest-centroid query above, minus the listings where
-- matching a parcel would just be matching Airbnb's random offset. Run the
-- ATTACH/LOAD lines from that query first.
-- ============================================================
-- SELECT l.listing_id, l.name, l.str_registration_id, p.parcel_id, p.parcel_address, p.owner_name
-- FROM listings l
-- JOIN parcels.parcels_current p ON p.tax_district = '4'
-- WHERE l.is_current AND l.location_is_exact
--   AND ST_Distance(
--         ST_Transform(ST_Point(l.location_lng, l.location_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true),
--         ST_Transform(ST_Point(p.centroid_lon, p.centroid_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true)
--       ) < 60;