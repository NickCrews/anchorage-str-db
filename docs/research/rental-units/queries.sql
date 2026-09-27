-- Queries behind README.md. Run against data/anchorage_str.duckdb:
--   duckdb -readonly data/anchorage_str.duckdb < docs/research/rental-units/queries.sql
-- Results change with every run; README.md quotes the 2026-09-26 daily run
-- and the 2026-09-26 registry run (layer last edited 2026-09-21).

LOAD spatial;
-- Points below are built as ST_Point(lat, lng), which ST_Distance_Sphere
-- reads as latitude first when this is false.
SET geometry_always_xy = false;

-- §2: active listings by listing type.
SELECT
    listing_type,
    count(*) AS listings,
    round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct,
    count(*) FILTER (WHERE registration_id IS NULL) AS no_id
FROM listings_active
GROUP BY 1
ORDER BY 2 DESC;

-- §2: listings that are not an entire home: how many hosts and
-- registrations they come from.
SELECT
    count(*) AS listings,
    count(DISTINCT host_id) AS hosts,
    count(DISTINCT (host_id, coalesce(registration_id, '-'))) AS host_registration_pairs,
    count(DISTINCT registration_id) AS registrations
FROM listings_active
WHERE listing_type <> 'Entire home/apt';

-- §2: entire-home listings that share a host and a registration id with
-- another entire-home listing. Combo listings are found among these.
WITH g AS (
    SELECT registration_id, host_id, count(*) AS n
    FROM listings_active
    WHERE listing_type = 'Entire home/apt' AND registration_id IS NOT NULL
    GROUP BY ALL
    HAVING n > 1
)
SELECT count(*) AS groups_, sum(n) AS listings
FROM g;

-- §2: listings whose names say they combine other listings or are a whole
-- building.
SELECT listing_id, name, bedrooms, host_id, registration_id
FROM listings_active
WHERE regexp_matches(
    lower(name),
    'combo|compound|both units|entire (building|property)|whole (house|building|property)|full \dbr|\d units|\+ ?(studio|suite|apt|unit)'
)
ORDER BY host_id;

-- §2: the 700 M St listings' not-available nights over the next 90 nights,
-- summed across listings and as distinct nights.
WITH c AS (
    SELECT listing_id, night_date, available
    FROM airbnb_calendar_status
    WHERE is_current
      AND night_date BETWEEN DATE '2026-09-27' AND DATE '2026-12-25'
      AND listing_id IN (
          SELECT listing_id FROM listings_active WHERE registration_id = 'STR20261828'
      )
)
SELECT
    count(*) FILTER (WHERE NOT available) AS listing_nights_not_available,
    count(DISTINCT night_date) FILTER (WHERE NOT available) AS nights_any_not_available
FROM c;

-- §2: Girdwood's share at each grain. Listings are placed by coordinate
-- (a box around the valley), registrations by the Muni's community council.
CREATE OR REPLACE TEMP TABLE l_gw AS
SELECT *, (location_lat BETWEEN 60.90 AND 61.03 AND location_lng BETWEEN -149.30 AND -148.95) AS gw
FROM listings_active;
CREATE OR REPLACE TEMP TABLE r_gw AS
SELECT *, community_council = 'Girdwood' AS gw
FROM registrations_active;

SELECT 'listings, by Airbnb place name' AS grain,
    count(*) FILTER (WHERE location_subtitle ILIKE '%girdwood%') AS girdwood, count(*) AS total
FROM listings_active
UNION ALL SELECT 'listings, by coordinate', count(*) FILTER (WHERE gw), count(*) FROM l_gw
UNION ALL SELECT 'entire-home listings', count(*) FILTER (WHERE gw), count(*) FROM l_gw WHERE listing_type = 'Entire home/apt'
UNION ALL SELECT 'other listings', count(*) FILTER (WHERE gw), count(*) FROM l_gw WHERE listing_type <> 'Entire home/apt'
UNION ALL SELECT 'hosts', count(DISTINCT host_id) FILTER (WHERE gw), count(DISTINCT host_id) FROM l_gw
UNION ALL SELECT 'registrations', count(*) FILTER (WHERE gw), count(*) FROM r_gw
UNION ALL SELECT 'registrations cited by a listing', count(*) FILTER (WHERE gw), count(*) FROM r_gw WHERE airbnb_listings_active > 0;

-- §2: registrations: how many name a room, and how many distinct geocoded
-- addresses they sit at.
SELECT
    count(*) FILTER (WHERE regexp_matches(upper(registered_address), '\b(ROOM|BEDROOM|BDRM|RM)\b')) AS names_a_room,
    count(DISTINCT geocoded_address) AS geocoded_addresses,
    count(*) AS registrations
FROM registrations_active;

-- §2: registrations by the listing types of the listings citing them.
WITH c AS (
    SELECT
        registration_id,
        bool_or(listing_type = 'Entire home/apt') AS cited_by_entire_home,
        bool_or(listing_type <> 'Entire home/apt') AS cited_by_other
    FROM listings_active
    WHERE registration_id IN (SELECT registration_id FROM registrations_active)
    GROUP BY 1
)
SELECT cited_by_entire_home, cited_by_other, count(*) AS registrations
FROM c
GROUP BY ALL;

-- §2: registrations by how many active listings cite them.
WITH c AS (
    SELECT r.registration_id, count(l.listing_id) AS n
    FROM registrations_active r
    LEFT JOIN listings_active l USING (registration_id)
    GROUP BY 1
)
SELECT least(n, 6) AS citing_listings, count(*) AS registrations
FROM c
GROUP BY 1
ORDER BY 1;

-- §2, §5: active registrations by how many share their geocoded address.
WITH c AS (
    SELECT count(*) OVER (PARTITION BY geocoded_address) AS sharing
    FROM registrations_active
    WHERE geocoded_lat IS NOT NULL
)
SELECT
    count(*) FILTER (WHERE sharing = 1) AS alone,
    count(*) FILTER (WHERE sharing > 1) AS shared,
    max(sharing) AS most_at_one_address
FROM c;

-- §1, §2, §4, §5: the listings behind the named registrations.
SELECT
    l.registration_id,
    l.listing_id,
    l.host_id,
    l.listing_type,
    l.bedrooms,
    l.guest_capacity,
    l.name,
    r.registered_address,
    r.business_name
FROM listings_active l
JOIN registrations r ON r.registration_id = l.registration_id
WHERE l.registration_id IN (
    'STR20261828', 'STR20260245', 'STR20260377', 'STR20261701',
    'STR20262058', 'STR20262059', 'STR20262060', 'STR20262061',
    'STR20262179', 'STR20262180', 'STR20262181', 'STR20262182',
    'STR20262194', 'STR20262195', 'STR20262196', 'STR20261146', 'STR20261147',
    'STR20260765', 'STR20262388', 'STR20260455', 'STR20262029'
)
ORDER BY 1, 2;

-- §2, §4, §5: registrations at the named addresses.
SELECT registration_id, registered_address, business_name, issued_date, airbnb_listings_active
FROM registrations_active
WHERE regexp_matches(
    upper(registered_address),
    '^(19841 CHUGACH PARK|1306 W 31ST|4011 TURNAGAIN|829 E\.? 13TH|4425 E [56]TH|3503 E 16TH|3706 OREGON|1742 W 12TH|400 TURPIN)'
)
ORDER BY registered_address, registration_id;

-- §4: every active listing, by what its printed id says.
CREATE OR REPLACE TEMP TABLE link AS
SELECT
    l.listing_id,
    l.location_is_exact,
    l.registration_id,
    r.registration_id IS NOT NULL AS in_active,
    ever.registration_id IS NOT NULL AS ever_published,
    CASE WHEN r.geocoded_lat IS NOT NULL THEN ST_Distance_Sphere(
        ST_Point(l.location_lat, l.location_lng),
        ST_Point(r.geocoded_lat, r.geocoded_lng)
    ) END AS meters
FROM listings_active l
LEFT JOIN registrations_active r ON r.registration_id = l.registration_id
LEFT JOIN (SELECT DISTINCT registration_id FROM registrations) ever
    ON ever.registration_id = l.registration_id;

SELECT
    CASE
        WHEN registration_id IS NULL THEN 'a: no id'
        WHEN NOT ever_published THEN 'b: id never published'
        WHEN NOT in_active THEN 'c: id lapsed'
        WHEN meters IS NULL THEN 'd: registration not geocoded'
        WHEN meters > 1000 THEN 'g: over 1 km'
        WHEN meters > CASE WHEN location_is_exact THEN 100 ELSE 300 END THEN 'f: nearby, beyond expected error'
        ELSE 'e: consistent'
    END AS category,
    count(*) AS listings,
    round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM link
GROUP BY 1
ORDER BY 1;

-- §4: distance from a listing's coordinate to its registration's geocoded
-- coordinate, by exact or jittered.
SELECT
    location_is_exact,
    count(*) AS listings,
    round(median(meters)) AS median_m,
    round(quantile_cont(meters, 0.9)) AS p90_m,
    count(*) FILTER (WHERE meters > 1000) AS over_1_km
FROM link
WHERE meters IS NOT NULL
GROUP BY 1;

-- §4: ids printed on listings but never published, against the highest id
-- and latest issue date the layer holds, and when the layer was last edited.
SELECT registration_id FROM link WHERE registration_id IS NOT NULL AND NOT ever_published ORDER BY 1;
SELECT max(registration_id) AS highest_id, max(issued_date) AS latest_issued FROM registrations_active;
SELECT scrape_date, layer_data_edited_at FROM muni_str_registry_runs ORDER BY 1 DESC LIMIT 1;

-- §4: listings with a street address.
SELECT count(location_exact_address) AS with_address, count(*) AS listings
FROM listings_active;

-- §4: registration ids cited by listings from more than one host.
SELECT count(*) AS registrations
FROM (
    SELECT registration_id
    FROM listings_active
    WHERE registration_id IS NOT NULL
    GROUP BY 1
    HAVING count(DISTINCT host_id) > 1
);

-- §4: for each listing with no id, the uncited registrations within 50 m of
-- an exact coordinate or 150 m of a jittered one.
WITH c AS (
    SELECT l.listing_id, l.location_is_exact, count(r.registration_id) AS candidates
    FROM listings_active l
    LEFT JOIN registrations_active r
        ON r.airbnb_listings_active = 0
        AND r.geocoded_lat IS NOT NULL
        AND ST_Distance_Sphere(
            ST_Point(l.location_lat, l.location_lng),
            ST_Point(r.geocoded_lat, r.geocoded_lng)
        ) < CASE WHEN l.location_is_exact THEN 50 ELSE 150 END
    WHERE l.registration_id IS NULL
    GROUP BY ALL
)
SELECT
    location_is_exact,
    count(*) AS listings,
    count(*) FILTER (WHERE candidates = 0) AS none,
    count(*) FILTER (WHERE candidates = 1) AS one,
    count(*) FILTER (WHERE candidates = 2) AS two,
    count(*) FILTER (WHERE candidates >= 3) AS three_or_more
FROM c
GROUP BY 1;

-- §4: all active registrations within 150 m of a jittered listing with no id.
WITH c AS (
    SELECT l.listing_id, count(r.registration_id) AS nearby
    FROM listings_active l
    LEFT JOIN registrations_active r
        ON r.geocoded_lat IS NOT NULL
        AND ST_Distance_Sphere(
            ST_Point(l.location_lat, l.location_lng),
            ST_Point(r.geocoded_lat, r.geocoded_lng)
        ) < 150
    WHERE l.registration_id IS NULL AND NOT coalesce(l.location_is_exact, false)
    GROUP BY ALL
)
SELECT median(nearby) AS median, quantile_cont(nearby, 0.9) AS p90, max(nearby) AS max
FROM c;

-- §4: listings with no id, by host.
SELECT host_id, count(*) AS listings
FROM listings_active
WHERE registration_id IS NULL
GROUP BY 1
ORDER BY 2 DESC
LIMIT 5;

-- §4: the Shaligo host's listings, each with the id it prints and its
-- distance to the three addresses Shaligo AK Stays registered.
SELECT
    l.listing_id,
    l.registration_id,
    l.location_is_exact,
    l.name,
    round(min(ST_Distance_Sphere(ST_Point(l.location_lat, l.location_lng), ST_Point(r.geocoded_lat, r.geocoded_lng)))
        FILTER (WHERE r.registered_address ILIKE '4425 E 6TH%')) AS m_to_4425_e_6th,
    round(min(ST_Distance_Sphere(ST_Point(l.location_lat, l.location_lng), ST_Point(r.geocoded_lat, r.geocoded_lng)))
        FILTER (WHERE r.registered_address ILIKE '3503 E 16TH%')) AS m_to_3503_e_16th,
    round(min(ST_Distance_Sphere(ST_Point(l.location_lat, l.location_lng), ST_Point(r.geocoded_lat, r.geocoded_lng)))
        FILTER (WHERE r.registered_address ILIKE '3706 OREGON%')) AS m_to_3706_oregon
FROM listings_active l, registrations_active r
WHERE l.host_id = 450844916
  AND r.business_name ILIKE 'shaligo%'
GROUP BY ALL
ORDER BY m_to_4425_e_6th;
