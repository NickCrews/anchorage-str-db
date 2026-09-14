-- How far every linked listing's Airbnb pin is from its registration's
-- geocoded point. The report quotes these to show the threshold in cases.sql
-- is beyond Airbnb's pin offset.

LOAD spatial;
SET geometry_always_xy = false;

WITH d AS (
    SELECT ST_Distance_Sphere(
        ST_Point(l.location_lat, l.location_lng),
        ST_Point(r.geocoded_lat, r.geocoded_lng)
    ) AS meters
    FROM listings_current l
    JOIN registrations_current r ON r.registration_number = l.str_registration_id
    WHERE r.geocoded_lat IS NOT NULL
      AND l.location_lat IS NOT NULL
)
SELECT
    count(*)::INTEGER AS compared,
    count(*) FILTER (WHERE meters > 200)::INTEGER AS over_200_m,
    count(*) FILTER (WHERE meters > 500 AND meters <= 1000)::INTEGER AS from_500_m_to_1_km,
    count(*) FILTER (WHERE meters > 1000)::INTEGER AS over_1_km
FROM d;
