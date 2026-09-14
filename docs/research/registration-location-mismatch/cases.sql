-- One row per current Airbnb listing whose map pin is more than 500 m from
-- the geocoded point of the registration it cites. build.sh runs this with
-- `duckdb -json` and embeds the result in report.html.

LOAD spatial;
-- Points below are built as ST_Point(lat, lng), which ST_Distance_Sphere
-- reads as latitude first when this is false.
SET geometry_always_xy = false;

-- For linked listings, no pin is between 500 m and 1 km from its registration
-- (2026-09-14), so the threshold separates Airbnb's pin offset (under 500 m)
-- from listings at a different place.
CREATE OR REPLACE TEMP MACRO threshold_m() AS 500;

CREATE OR REPLACE TEMP MACRO meters(lat1, lng1, lat2, lng2) AS
    ST_Distance_Sphere(ST_Point(lat1, lng1), ST_Point(lat2, lng2));

CREATE OR REPLACE TEMP TABLE linked AS
SELECT
    l.listing_id,
    l.name,
    l.url,
    l.room_type,
    l.bedrooms,
    l.guest_capacity,
    l.location_lat,
    l.location_lng,
    l.location_is_exact,
    l.location_subtitle,
    l.host_id,
    l.host_name,
    l.page_seen_date,
    p.photo_urls[1] AS photo_url,
    r.registration_number,
    meters(l.location_lat, l.location_lng, r.geocoded_lat, r.geocoded_lng) AS distance_m
FROM listings_current_with_host l
JOIN registrations_current r ON r.registration_number = l.str_registration_id
LEFT JOIN listing_photos_current p ON p.listing_id = l.listing_id
WHERE r.geocoded_lat IS NOT NULL
  AND l.location_lat IS NOT NULL;

SELECT
    l.listing_id::VARCHAR AS listing_id,
    l.name AS listing_name,
    l.url AS listing_url,
    l.room_type,
    l.bedrooms,
    l.guest_capacity,
    l.location_lat AS listing_lat,
    l.location_lng AS listing_lng,
    l.location_is_exact AS listing_pin_is_exact,
    l.host_id::VARCHAR AS host_id,
    l.host_name,
    l.page_seen_date AS listing_seen_date,
    l.photo_url,
    round(l.distance_m)::INTEGER AS distance_m,

    r.registration_number,
    r.business_name,
    r.location AS registered_address,
    r.geocoded_address,
    r.geocoded_lat AS registered_lat,
    r.geocoded_lng AS registered_lng,
    r.community_council,
    r.issued_date,
    r.status_url AS license_url,
    r.published_at::DATE AS registry_published_date,

    -- Every current listing citing this registration, this one included.
    (
        SELECT list({
            'listing_id': o.listing_id::VARCHAR,
            'name': o.name,
            'url': o.url,
            'lat': o.location_lat,
            'lng': o.location_lng,
            'pin_is_exact': o.location_is_exact,
            'host_name': o.host_name,
            'distance_m': round(o.distance_m)::INTEGER
        } ORDER BY o.distance_m)
        FROM linked o
        WHERE o.registration_number = l.registration_number
    ) AS listings_on_number,

    -- Other current registrations within 200 m of this listing's pin: a
    -- registration that may cover the place the listing is.
    (
        SELECT list({
            'registration_number': n.registration_number,
            'business_name': n.business_name,
            'address': n.location,
            'lat': n.geocoded_lat,
            'lng': n.geocoded_lng,
            'license_url': n.status_url,
            'distance_m': round(meters(l.location_lat, l.location_lng, n.geocoded_lat, n.geocoded_lng))::INTEGER
        } ORDER BY meters(l.location_lat, l.location_lng, n.geocoded_lat, n.geocoded_lng))
        FROM registrations_current n
        WHERE n.geocoded_lat IS NOT NULL
          AND n.registration_number <> l.registration_number
          AND meters(l.location_lat, l.location_lng, n.geocoded_lat, n.geocoded_lng) < 200
    ) AS registrations_near_listing
FROM linked l
JOIN registrations_current r USING (registration_number)
WHERE l.distance_m > threshold_m()
ORDER BY r.registration_number, l.distance_m DESC;
