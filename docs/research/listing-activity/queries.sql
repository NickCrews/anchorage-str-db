-- Listing activity: the queries behind README.md.
--
-- Run against the published database after building the viewer's estimate
-- tables (ESTIMATE_STATEMENTS in packages/ui/src/model/estimates.ts), which
-- these read: est_nights, est_listings, est_listing_months, est_listing_rate.

-- One row per active listing with every activity signal.
CREATE OR REPLACE TEMP TABLE dormancy_signals AS
WITH latest AS (SELECT max(scrape_date) AS d FROM airbnb_scrape_runs),
active AS (
  SELECT listing_id, listing_type, first_seen_date, first_review_date, registration_id
  FROM listings_active
  WHERE valid_to IS NULL
),
future AS (
  SELECT
    listing_id,
    count(*) FILTER (WHERE available) AS future_nights_available,
    count(*) FILTER (WHERE available AND night_date < (SELECT d FROM latest) + 90) AS next_90_nights_available
  FROM calendar_current
  WHERE night_date >= (SELECT d FROM latest)
  GROUP BY listing_id
),
past AS (
  SELECT
    listing_id,
    count(*) AS past_nights,
    count(*) FILTER (WHERE state = 'available') AS past_nights_available
  FROM est_nights
  WHERE is_past
  GROUP BY listing_id
),
-- Nights seen going from available to not available before their date.
seen_closing AS (
  SELECT c.listing_id, count(*) AS nights_seen_closing
  FROM airbnb_calendar_status c
  JOIN airbnb_calendar_status p
    ON p.listing_id = c.listing_id AND p.night_date = c.night_date AND p.valid_to = c.valid_from
  WHERE p.available AND NOT c.available AND c.valid_from < c.night_date
  GROUP BY c.listing_id
),
reviews AS (
  SELECT
    listing_id,
    arg_min(review_count, scrape_date) FILTER (WHERE review_count IS NOT NULL) AS reviews_first,
    arg_max(review_count, scrape_date) FILTER (WHERE review_count IS NOT NULL) AS reviews_last
  FROM airbnb_listing_observations
  GROUP BY listing_id
)
SELECT
  a.*,
  f.future_nights_available,
  f.next_90_nights_available,
  p.past_nights,
  p.past_nights_available,
  coalesce(s.nights_seen_closing, 0) AS nights_seen_closing,
  r.reviews_last,
  coalesce(r.reviews_last, 0) - coalesce(r.reviews_first, 0) AS new_reviews,
  reg.is_active AS registration_is_active,
  CASE
    WHEN f.future_nights_available = 0 THEN 'closed'
    WHEN f.next_90_nights_available = 0 THEN 'closed for the season'
    WHEN coalesce(s.nights_seen_closing, 0) = 0 AND coalesce(r.reviews_last, 0) - coalesce(r.reviews_first, 0) = 0
      THEN 'unbooked'
    ELSE 'rented'
  END AS pattern
FROM active a
LEFT JOIN future f USING (listing_id)
LEFT JOIN past p USING (listing_id)
LEFT JOIN seen_closing s USING (listing_id)
LEFT JOIN reviews r USING (listing_id)
LEFT JOIN registrations reg USING (registration_id);

-- Table 1: active listings by pattern, and how each pattern differs.
SELECT
  pattern,
  count(*) AS listings,
  round(100 * avg(l.owner_occupied_exemption::INT), 1) AS pct_owner_occupied_exemption,
  round(100 * avg((d.registration_is_active IS NOT TRUE)::INT), 1) AS pct_registration_not_active,
  round(100 * avg((coalesce(d.reviews_last, 0) = 0)::INT), 1) AS pct_never_reviewed,
  round(100 * avg((d.listing_type <> 'Entire home/apt')::INT), 1) AS pct_not_entire_home
FROM dormancy_signals d
JOIN est_listings l USING (listing_id)
GROUP BY ROLLUP (pattern)
ORDER BY pattern;

-- Table 2: when the listings closed for the season open again.
SELECT
  CAST(date_trunc('month', night_date) AS DATE) AS month,
  count(DISTINCT listing_id) FILTER (WHERE available) AS listings_with_a_night_available
FROM calendar_current
JOIN dormancy_signals USING (listing_id)
WHERE pattern = 'closed for the season'
  AND night_date >= (SELECT max(scrape_date) FROM airbnb_scrape_runs)
GROUP BY ALL
ORDER BY month;

-- Table 3: October 2026 earnings by pattern.
SELECT
  pattern,
  count(*) AS listings,
  CAST(quantile_cont(m.revenue, 0.5) AS INTEGER) AS median_revenue,
  count(*) FILTER (WHERE m.nights_booked = 0) AS listings_with_no_booked_night
FROM est_listing_months m
JOIN dormancy_signals USING (listing_id)
WHERE m.month = DATE '2026-10-01' AND m.revenue IS NOT NULL
GROUP BY ROLLUP (pattern)
ORDER BY pattern;

-- Table 4: the October median under each inclusion rule.
SELECT 'every listing' AS rule, CAST(quantile_cont(revenue, 0.5) AS INTEGER) AS median_revenue, count(*) AS listings
FROM est_listing_months JOIN dormancy_signals USING (listing_id)
WHERE month = DATE '2026-10-01' AND revenue IS NOT NULL
UNION ALL
SELECT 'without closed and unbooked', CAST(quantile_cont(revenue, 0.5) AS INTEGER), count(*)
FROM est_listing_months JOIN dormancy_signals USING (listing_id)
WHERE month = DATE '2026-10-01' AND revenue IS NOT NULL AND pattern NOT IN ('closed', 'unbooked')
UNION ALL
SELECT 'rented only (circular)', CAST(quantile_cont(revenue, 0.5) AS INTEGER), count(*)
FROM est_listing_months JOIN dormancy_signals USING (listing_id)
WHERE month = DATE '2026-10-01' AND revenue IS NOT NULL AND pattern = 'rented';

-- Table 5: listings that left search under the 5-day rule on some run, and
-- those later seen again under the same listing_id.
WITH runs AS (SELECT DISTINCT scrape_date FROM airbnb_scrape_runs WHERE listings_seen IS NOT NULL),
seen AS (SELECT DISTINCT listing_id, scrape_date FROM airbnb_listing_observations),
grid AS (
  SELECT l.listing_id, r.scrape_date, max(s.scrape_date) AS last_seen_by_then
  FROM (SELECT DISTINCT listing_id FROM seen) l
  CROSS JOIN runs r
  JOIN seen s ON s.listing_id = l.listing_id AND s.scrape_date <= r.scrape_date
  GROUP BY ALL
),
out AS (
  SELECT g.listing_id, g.scrape_date
  FROM grid g
  WHERE g.scrape_date - g.last_seen_by_then > 5
)
SELECT
  (SELECT count(DISTINCT listing_id) FROM seen) AS listings_ever_seen,
  count(DISTINCT o.listing_id) AS left_search,
  count(DISTINCT o.listing_id) FILTER (
    WHERE EXISTS (SELECT 1 FROM seen s WHERE s.listing_id = o.listing_id AND s.scrape_date > o.scrape_date)
  ) AS returned_to_search
FROM out o;

-- Table 6: the listings that left search between the 2026-09-30 and
-- 2026-10-01 runs, against those that stayed.
WITH a AS (SELECT DISTINCT listing_id FROM airbnb_listing_observations WHERE scrape_date = DATE '2026-09-30'),
b AS (SELECT DISTINCT listing_id FROM airbnb_listing_observations WHERE scrape_date = DATE '2026-10-01'),
gone AS (SELECT listing_id FROM a ANTI JOIN b USING (listing_id))
SELECT
  listing_id IN (SELECT listing_id FROM gone) AS left_on_oct_1,
  count(*) AS listings,
  round(100 * avg((registration_id IS NOT NULL)::INT), 1) AS pct_showing_a_registration_id
FROM airbnb_listing_observations
WHERE scrape_date = DATE '2026-09-30'
GROUP BY ALL;

-- Table 7: what became of the 2026-10-01 leavers.
WITH a AS (SELECT DISTINCT listing_id FROM airbnb_listing_observations WHERE scrape_date = DATE '2026-09-30'),
b AS (SELECT DISTINCT listing_id FROM airbnb_listing_observations WHERE scrape_date = DATE '2026-10-01'),
gone AS (
  SELECT o.listing_id, o.host_id, o.listing_type, o.bedrooms
  FROM airbnb_listing_observations o
  WHERE o.scrape_date = DATE '2026-09-30' AND o.listing_id IN (SELECT listing_id FROM a ANTI JOIN b USING (listing_id))
),
summer AS (
  SELECT DISTINCT c.listing_id
  FROM airbnb_calendar_status c
  JOIN gone USING (listing_id)
  WHERE c.available AND c.night_date BETWEEN DATE '2027-05-01' AND DATE '2027-08-31'
    AND c.valid_from <= DATE '2026-09-30' AND (c.valid_to IS NULL OR c.valid_to > DATE '2026-09-30')
),
returned AS (
  SELECT DISTINCT listing_id FROM airbnb_listing_observations JOIN gone USING (listing_id)
  WHERE scrape_date > DATE '2026-10-01'
),
lookalike AS (
  SELECT DISTINCT g.listing_id
  FROM gone g
  JOIN listings n
    ON n.valid_to IS NULL AND n.first_seen_date > DATE '2026-10-01'
    AND n.host_id = g.host_id AND n.listing_type = g.listing_type AND n.bedrooms = g.bedrooms
)
SELECT
  count(*) AS left_on_oct_1,
  count(*) FILTER (WHERE listing_id IN (SELECT listing_id FROM summer)) AS had_summer_2027_nights_open,
  count(*) FILTER (WHERE listing_id IN (SELECT listing_id FROM returned)) AS returned_same_id,
  count(*) FILTER (WHERE listing_id IN (SELECT listing_id FROM lookalike)) AS host_has_new_lookalike_listing
FROM gone;
