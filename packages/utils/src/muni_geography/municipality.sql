-- Builds municipality.geojson, the Municipality boundary `index.ts` exports.
-- Run from this directory:
--
--     rm -f municipality.geojson && duckdb < municipality.sql
--
-- The source is the Muni's community council polygons, layer 1 of the STR
-- registration service shown in the Short Term Rental Registration Viewer
-- (https://experience.arcgis.com/experience/22b40a78a9fc459e9950a16249b37ed2).
-- Together the councils cover the Municipality's settled areas. They leave
-- holes and gaps over uninhabited land, so the holes are filled. Fire Island,
-- which is uninhabited, is in no council and falls outside.
--
-- The union is padded by 1 km because Airbnb shows most listings at a blurred
-- position. For listings not flagged exact, the blurred point is 92 m from the
-- Muni's geocoded address for the registration it cites at the median and
-- 150 m at the 95th percentile (1361 listings, 2026-09-14), and 6 of 2519
-- listings in the Municipality fell up to 232 m outside the unpadded union.
-- The nearest listing outside the Municipality, in Hope, is 5.9 km from the
-- padded edge.
--
-- Every home is inside. Of the 98,550 parcel centroids in
-- https://github.com/NickCrews/anchorage-property, 100 fall outside the
-- boundary and none has a living unit (2026-09-14). The only buildings on
-- them are the Fire Island wind farm, Doyon Utilities' office and warehouses,
-- and the Anchorage Ski Club's clubhouse.
--
-- Buffering and simplifying happen in Alaska Albers (EPSG:3338), in meters.

INSTALL spatial;
LOAD spatial;
SET geometry_always_xy = true;

CREATE TEMP TABLE councils AS
SELECT geom
FROM ST_Read('/vsicurl/https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/ShortTermRental_Registrations_Hosted/FeatureServer/1/query?where=1%3D1&outFields=CommunityCouncil&outSR=4326&f=geojson');

COPY (
  WITH parts AS (
    SELECT unnest(ST_Dump(ST_Union_Agg(ST_Transform(geom, 'EPSG:4326', 'EPSG:3338')))).geom AS geom
    FROM councils
  ),
  filled AS (
    SELECT ST_Union_Agg(ST_MakePolygon(ST_ExteriorRing(geom))) AS geom
    FROM parts
  )
  SELECT ST_Transform(
    ST_SimplifyPreserveTopology(ST_Buffer(geom, 1000), 50),
    'EPSG:3338',
    'EPSG:4326'
  ) AS geom
  FROM filled
) TO 'municipality.geojson'
WITH (
  FORMAT GDAL,
  DRIVER 'GeoJSON',
  LAYER_CREATION_OPTIONS ('RFC7946=YES', 'COORDINATE_PRECISION=5')
);
