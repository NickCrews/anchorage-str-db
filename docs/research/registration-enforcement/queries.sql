-- Queries behind README.md. Run against data/anchorage_str.duckdb:
--   duckdb -readonly data/anchorage_str.duckdb < docs/research/registration-enforcement/queries.sql
-- Results after the 2026-10-01 run grow as listings come back. README.md
-- quotes the database as of the 2026-11-27 run.

-- Setup: the listings search showed on 2026-09-30 and not on 2026-10-01, and
-- the listings it showed on both.
CREATE OR REPLACE TEMP TABLE removed AS
SELECT *
FROM airbnb_listing_observations
WHERE scrape_date = DATE '2026-09-30'
  AND listing_id NOT IN (
      SELECT listing_id FROM airbnb_listing_observations
      WHERE scrape_date = DATE '2026-10-01'
  );

CREATE OR REPLACE TEMP TABLE stayed AS
SELECT *
FROM airbnb_listing_observations
WHERE scrape_date = DATE '2026-09-30'
  AND listing_id IN (
      SELECT listing_id FROM airbnb_listing_observations
      WHERE scrape_date = DATE '2026-10-01'
  );

-- 1. Listings that dropped out of search between consecutive runs. A gap
-- in the run dates makes a row cover more than one day.
WITH runs AS (
    SELECT scrape_date, lag(scrape_date) OVER (ORDER BY scrape_date) AS prev_date
    FROM (SELECT DISTINCT scrape_date FROM airbnb_listing_observations)
)
SELECT
    r.scrape_date,
    r.prev_date,
    count(*) AS dropped
FROM runs r
JOIN airbnb_listing_observations a ON a.scrape_date = r.prev_date
ANTI JOIN airbnb_listing_observations b
    ON b.scrape_date = r.scrape_date AND b.listing_id = a.listing_id
GROUP BY ALL
ORDER BY r.scrape_date;

-- 2. Registration id shown on 2026-09-30, removed vs stayed.
SELECT
    'removed' AS grp,
    count(*) AS listings,
    count(*) FILTER (registration_id IS NULL) AS no_id,
    round(100 * avg((registration_id IS NULL)::int), 1) AS pct_no_id
FROM removed
UNION ALL
SELECT 'stayed', count(*), count(*) FILTER (registration_id IS NULL),
    round(100 * avg((registration_id IS NULL)::int), 1)
FROM stayed;

-- 3. Removed listings by listing type.
SELECT listing_type, count(*) AS listings FROM removed GROUP BY 1 ORDER BY 2 DESC;

-- 4. Removed listings with at least one night in June through August 2027
-- available on the calendar as stored on 2026-09-30.
SELECT count(DISTINCT r.listing_id) AS with_summer_2027_open
FROM removed r
JOIN airbnb_calendar_status c USING (listing_id)
WHERE c.night_date BETWEEN DATE '2027-06-01' AND DATE '2027-08-31'
  AND c.available
  AND c.valid_from <= DATE '2026-09-30'
  AND (c.valid_to IS NULL OR c.valid_to > DATE '2026-09-30');

-- 5. Hosts behind the removed listings.
SELECT count(DISTINCT host_id) AS hosts, max(n) AS most_from_one_host
FROM (SELECT host_id, count(*) AS n FROM removed GROUP BY 1);

-- 6. Removed listings that search showed again after 2026-10-01, by whether
-- they showed an id on 2026-09-30 and on their latest run.
WITH back AS (
    SELECT listing_id, arg_max(registration_id, scrape_date) AS registration_id_now
    FROM airbnb_listing_observations
    WHERE scrape_date > DATE '2026-10-01'
      AND listing_id IN (SELECT listing_id FROM removed)
    GROUP BY 1
)
SELECT
    r.registration_id IS NOT NULL AS had_id_before,
    b.registration_id_now IS NOT NULL AS has_id_now,
    count(*) AS listings
FROM back b
JOIN removed r USING (listing_id)
GROUP BY ALL
ORDER BY ALL;
