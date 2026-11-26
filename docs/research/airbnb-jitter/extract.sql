-- Writes the CSVs the notebook reads, from the published database.
-- Run from the repo root:
--   duckdb anchorage_str.duckdb -c ".read docs/research/airbnb-jitter/extract.sql"

-- Every active listing with a coordinate: Airbnb's pin, whether it is exact,
-- and the registration id it prints. Coordinates are written at full
-- precision, so their decimal places can be read back.
COPY (
    SELECT listing_id, location_lat AS pin_lat, location_lng AS pin_lng,
           location_is_exact AS is_exact, registration_id
    FROM listings_active
    WHERE location_lat IS NOT NULL AND location_is_exact IS NOT NULL
    ORDER BY listing_id
) TO 'docs/research/airbnb-jitter/public/listings.csv' (HEADER);

-- Every active, geocoded registration, with the number of parcel centroids
-- within 500 m of its point as a measure of density.
COPY (
    WITH r AS (
        SELECT registration_id, geocoded_lat, geocoded_lng
        FROM registrations_active
        WHERE geocoded_lat IS NOT NULL
    )
    SELECT r.registration_id, r.geocoded_lat, r.geocoded_lng,
           count(p.parcel_id) AS parcels_within_500m
    FROM r
    LEFT JOIN property_parcels p
      ON p.centroid_lat BETWEEN r.geocoded_lat - 0.005 AND r.geocoded_lat + 0.005
     AND p.centroid_lon BETWEEN r.geocoded_lng - 0.01 AND r.geocoded_lng + 0.01
     AND pow((p.centroid_lat - r.geocoded_lat) * 111195, 2)
       + pow((p.centroid_lon - r.geocoded_lng) * 111195 * cos(radians(r.geocoded_lat)), 2)
       < 500 * 500
    GROUP BY ALL
    ORDER BY r.registration_id
) TO 'docs/research/airbnb-jitter/public/registrations.csv' (HEADER);

-- Listings that showed both an exact and a jittered coordinate over the
-- scrape history: each distinct (coordinate, flag) with the dates it was seen.
COPY (
    WITH d AS (
        SELECT listing_id, location_lat AS pin_lat, location_lng AS pin_lng,
               location_is_exact AS is_exact,
               min(scrape_date) AS first_seen, max(scrape_date) AS last_seen
        FROM airbnb_listing_observations
        WHERE location_lat IS NOT NULL AND location_is_exact IS NOT NULL
        GROUP BY ALL
    )
    SELECT * FROM d
    WHERE listing_id IN (
        SELECT listing_id FROM d GROUP BY 1 HAVING count(DISTINCT is_exact) = 2
    )
    ORDER BY listing_id, first_seen
) TO 'docs/research/airbnb-jitter/public/flips.csv' (HEADER);
