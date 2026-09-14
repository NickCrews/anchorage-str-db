-- Queries behind README.md. Run against data/anchorage_str.duckdb:
--   duckdb -readonly data/anchorage_str.duckdb < docs/research/rental-units/queries.sql
-- Results change with every scrape; README.md quotes the 2026-09-14 run.

LOAD spatial;
-- Points below are built as ST_Point(lat, lng), which ST_Distance_Sphere
-- reads as latitude first when this is false.
SET geometry_always_xy = false;

-- §1, §2: registrations cited by more than one current listing, by the mix
-- of room types and hosts.
WITH m AS (
    SELECT
        str_registration_id,
        count(*) AS listings,
        count(DISTINCT host_id) AS hosts,
        list(DISTINCT room_type) AS room_types
    FROM listings_current
    WHERE str_registration_id IS NOT NULL
    GROUP BY 1
    HAVING listings > 1
)
SELECT
    CASE
        WHEN list_contains(room_types, 'Entire home/apt') AND len(room_types) > 1 THEN 'entire and private'
        WHEN hosts > 1 THEN 'several hosts'
        WHEN room_types = ['Private room'] THEN 'private rooms'
        WHEN room_types = ['Entire home/apt'] THEN 'entire homes'
        ELSE 'other'
    END AS kind,
    count(*) AS registrations
FROM m
GROUP BY 1
ORDER BY 1;

-- §1, §2, §5: the listings behind the named registrations.
SELECT
    l.str_registration_id,
    l.listing_id,
    l.host_id,
    l.room_type,
    l.bedrooms,
    l.guest_capacity,
    l.name,
    r.location,
    r.business_name
FROM listings_current l
JOIN registrations r ON r.registration_number = l.str_registration_id
WHERE l.str_registration_id IN (
    'STR20261828', 'STR20260245', 'STR20260377', 'STR20261701',
    'STR20262058', 'STR20262059', 'STR20262060', 'STR20262061',
    'STR20262180', 'STR20262182', 'STR20262194', 'STR20262195', 'STR20262196',
    'STR20260765', 'STR20262388', 'STR20260455'
)
ORDER BY 1, 2;

-- §3: current registrations by how many share their geocoded address.
WITH c AS (
    SELECT count(*) OVER (PARTITION BY geocoded_address) AS sharing
    FROM registrations_current
    WHERE geocoded_lat IS NOT NULL
)
SELECT sharing, count(*) AS registrations
FROM c
GROUP BY 1
ORDER BY 1;

-- §3, §4: registrations at the named addresses.
SELECT registration_number, location, business_name, issued_date, airbnb_listings_current
FROM registrations_current
WHERE regexp_matches(
    upper(location),
    '^(19841 CHUGACH PARK|1306 W 31ST|4011 TURNAGAIN|829 E\.? 13TH|4425 E 6TH|1742 W 12TH)'
)
ORDER BY location, registration_number;

-- §4: listings with no registration number, by Airbnb's place name.
SELECT
    location_subtitle,
    count(*) FILTER (WHERE str_registration_id IS NULL) AS no_number,
    count(*) AS listings
FROM listings_current
GROUP BY 1
ORDER BY listings DESC;

-- §4: listings with a street address.
SELECT count(location_exact_address) AS with_address, count(*) AS listings
FROM listings_current;

-- §4, §5: distance from a linked listing's pin to its license's geocoded point.
WITH d AS (
    SELECT
        l.location_is_exact,
        ST_Distance_Sphere(
            ST_Point(l.location_lat, l.location_lng),
            ST_Point(r.geocoded_lat, r.geocoded_lng)
        ) AS meters
    FROM listings_current l
    JOIN registrations_current r ON r.registration_number = l.str_registration_id
    WHERE r.geocoded_lat IS NOT NULL
)
SELECT
    location_is_exact,
    count(*) AS listings,
    round(median(meters)) AS median_m,
    round(quantile_cont(meters, 0.9)) AS p90_m,
    count(*) FILTER (WHERE meters > 1000) AS over_1_km
FROM d
GROUP BY 1;

-- §4: registrations with no listing near each unlinked listing inside the Muni.
CREATE OR REPLACE TEMP TABLE unlinked_listings AS
SELECT l.*
FROM listings_current l
LEFT JOIN registrations r ON r.registration_number = l.str_registration_id
WHERE r.registration_number IS NULL
  AND regexp_matches(lower(l.location_subtitle), 'anchorage|girdwood|eagle river|chugiak');

WITH c AS (
    SELECT l.listing_id, l.location_is_exact, count(r.registration_number) AS candidates
    FROM unlinked_listings l
    LEFT JOIN registrations_current r
        ON r.airbnb_listings_current = 0
        AND r.geocoded_lat IS NOT NULL
        AND ST_Distance_Sphere(
            ST_Point(l.location_lat, l.location_lng),
            ST_Point(r.geocoded_lat, r.geocoded_lng)
        ) < CASE WHEN l.location_is_exact THEN 50 ELSE 150 END
    GROUP BY ALL
)
SELECT
    location_is_exact,
    CASE WHEN candidates >= 3 THEN '3+' ELSE candidates::VARCHAR END AS candidates,
    count(*) AS listings
FROM c
GROUP BY ALL
ORDER BY ALL;

-- §4: all current registrations within 150 m of an approximate unlinked pin.
WITH c AS (
    SELECT l.listing_id, count(r.registration_number) AS nearby
    FROM unlinked_listings l
    LEFT JOIN registrations_current r
        ON r.geocoded_lat IS NOT NULL
        AND ST_Distance_Sphere(
            ST_Point(l.location_lat, l.location_lng),
            ST_Point(r.geocoded_lat, r.geocoded_lng)
        ) < 150
    WHERE NOT coalesce(l.location_is_exact, false)
    GROUP BY ALL
)
SELECT median(nearby) AS median, quantile_cont(nearby, 0.9) AS p90, max(nearby) AS max
FROM c;

-- §4: the Shaligo listings' distance from 4425 E 6th Ave.
SELECT
    l.listing_id,
    l.name,
    l.room_type,
    l.location_is_exact,
    round(ST_Distance_Sphere(
        ST_Point(l.location_lat, l.location_lng),
        ST_Point(r.geocoded_lat, r.geocoded_lng)
    )) AS meters
FROM listings_current l, registrations_current r
WHERE l.host_id = 450844916
  AND r.registration_number = 'STR20262241'
ORDER BY meters;

-- §5: registration numbers cited by listings from more than one host.
SELECT count(*) AS registrations
FROM (
    SELECT str_registration_id
    FROM listings_current
    WHERE str_registration_id IS NOT NULL
    GROUP BY 1
    HAVING count(DISTINCT host_id) > 1
);
