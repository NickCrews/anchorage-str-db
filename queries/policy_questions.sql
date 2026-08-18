-- Ready-made answers to the questions GBOS actually asks. Run with:
--   uv run girdwood-str sql   (not implemented yet — for now: duckdb data/girdwood_str.duckdb)
-- or attach the published database read-only from anywhere:
--   ATTACH 'girdwood_str.duckdb' AS str (READ_ONLY);

-- ============================================================
-- Q: How many houses are up (operating as an STR) on a given night?
-- "Up" = had that night in its calendar at all, whether booked or open.
-- ============================================================
SELECT
    night_date,
    count(DISTINCT listing_id) AS listings_operating
FROM calendar_status
WHERE night_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL 90 DAY
GROUP BY ALL
ORDER BY night_date;

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
    count(*) FILTER (WHERE NOT available) AS booked,
    count(*) FILTER (WHERE available)     AS vacant,
    count(*)                              AS total_operating,
    round(100.0 * count(*) FILTER (WHERE NOT available) / count(*), 1) AS pct_booked
FROM calendar_status
WHERE is_current  -- swap for a valid_from/valid_to filter to ask "as observed on date X"
GROUP BY ALL
ORDER BY night_date;

-- ============================================================
-- Q: How many distinct houses in Girdwood operated as an STR in the last year?
-- ============================================================
SELECT count(DISTINCT listing_id) AS distinct_strs_last_365_days
FROM listing_observations
WHERE scrape_date >= CURRENT_DATE - INTERVAL 365 DAY;

-- Same, broken out by month, to see growth/decline over time:
SELECT
    date_trunc('month', scrape_date) AS month,
    count(DISTINCT listing_id) AS distinct_strs_that_month
FROM listing_observations
GROUP BY ALL
ORDER BY month;

-- ============================================================
-- Q: How many STRs are currently active, and how has that count trended?
-- ============================================================
SELECT scrape_date, listings_seen, listings_new, listings_retired
FROM scrape_runs
ORDER BY scrape_date;

-- ============================================================
-- Q: What does a single listing's history look like — name/size changes,
-- and a year of night-by-night status?
-- ============================================================
-- SELECT * FROM listings WHERE listing_id = :id ORDER BY valid_from;
-- SELECT night_date, available, valid_from FROM calendar_status
--   WHERE listing_id = :id ORDER BY night_date;

-- ============================================================
-- Q: Bedroom-size mix of Girdwood's STR inventory right now (a proxy for
-- how much housing stock — studios vs. family-sized homes — is tied up).
-- ============================================================
SELECT
    coalesce(bedrooms::VARCHAR, 'studio/unknown') AS bedrooms,
    count(*) AS n_listings
FROM listings
WHERE is_current
GROUP BY ALL
ORDER BY bedrooms;

-- ============================================================
-- Cross-reference with the parcel lake: which specific parcels are running
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
--             ST_Transform(ST_Point(l.lng, l.lat), 'EPSG:4326', 'EPSG:3338', always_xy := true),
--             ST_Transform(ST_Point(p.centroid_lon, p.centroid_lat), 'EPSG:4326', 'EPSG:3338', always_xy := true)
--         ) AS match_m,
--         row_number() OVER (PARTITION BY l.listing_id ORDER BY
--             ST_Distance(
--                 ST_Transform(ST_Point(l.lng, l.lat), 'EPSG:4326', 'EPSG:3338', always_xy := true),
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
