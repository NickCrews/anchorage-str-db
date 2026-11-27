import { FREHM_STATEMENT } from './freh';

/**
 * The estimates the story is told with, as SQL run in the browser once the
 * database is attached. They are the viewer's interpretation, not facts the
 * database records, so they live here and not in `packages/db`.
 *
 * Airbnb publishes one bit per night, available or not, and prices only
 * stays that are still open. Revenue and occupancy therefore have to be
 * estimated:
 *
 * - A night's state is the last one observed on a run *before* that night.
 *   Airbnb closes most nights on their own date (same-day cutoff), so a run
 *   on the night itself would read that cutoff as a booking.
 * - A not-available night in a run of more than `BLOCK_RUN_NIGHTS`
 *   consecutive not-available nights is **blocked**: a season closed, an
 *   owner's stay, a long-term tenant. Shorter runs are **booked**.
 * - A booked night is **observed** when an earlier run saw it available, so
 *   the change to not available was seen. Otherwise it was already closed
 *   when first read, and is **inferred**.
 * - Each listing-month is priced at the median of the listing's quotes
 *   whose check-in falls in that month, else of all its quotes. Quotes are
 *   for open stays and include last-minute discounts, so they lean low.
 *
 * Every figure has a band: low counts only observed bookings, high counts
 * every not-available night as booked.
 */

/** A run of consecutive not-available nights longer than this is blocked, not booked. */
export const BLOCK_RUN_NIGHTS = 14;

/** Anchorage's room tax on stays under 30 days (AMC 12.20). */
export const ROOM_TAX_RATE = 0.12;

/** The Muni's places, for the mailing addresses of parcel owners. */
const MUNI_CITIES = [
  'ANCHORAGE',
  'EAGLE RIVER',
  'CHUGIAK',
  'GIRDWOOD',
  'INDIAN',
  'JBER',
  'ELMENDORF AFB',
  'FORT RICHARDSON',
  'PETERS CREEK',
];

const COUNCIL_AREA = `CASE
  WHEN community_council = 'Girdwood' OR location_subtitle ILIKE '%girdwood%' THEN 'Girdwood'
  WHEN community_council IN ('Eagle River', 'Eagle River Valley', 'Chugiak', 'Birchwood', 'South Fork', 'Eklutna Valley')
    OR location_subtitle ILIKE '%eagle river%' OR location_subtitle ILIKE '%chugiak%' THEN 'Eagle River–Chugiak'
  ELSE 'Anchorage Bowl'
END`;

/**
 * Statements that create the `est_*` tables, in order. Each is a separate
 * statement so a failure names the table.
 */
export const ESTIMATE_STATEMENTS: [table: string, sql: string][] = [
  [
    'est_run_dates',
    `CREATE OR REPLACE TABLE est_run_dates AS
     SELECT
       min(scrape_date) AS first_run_date,
       max(scrape_date) AS latest_run_date
     FROM airbnb_scrape_runs`,
  ],
  [
    // One row per listing per night with calendar data from a run before
    // the night. Past nights are settled; future nights are on the books.
    'est_nights',
    `CREATE OR REPLACE TABLE est_nights AS
     WITH before_night AS (
       SELECT listing_id, night_date, available, valid_from
       FROM airbnb_calendar_status
       WHERE valid_from < night_date
     ),
     last_state AS (
       SELECT listing_id, night_date, available,
         bool_or(available) OVER (PARTITION BY listing_id, night_date) AS ever_available
       FROM before_night
       QUALIFY row_number() OVER (PARTITION BY listing_id, night_date ORDER BY valid_from DESC) = 1
     ),
     -- Keep the nights calendar_current keeps: it drops inactive listings' frozen future nights.
     kept AS (
       SELECT s.*
       FROM last_state s
       SEMI JOIN calendar_current c USING (listing_id, night_date)
     ),
     grouped AS (
       SELECT *,
         night_date - CAST(row_number() OVER (PARTITION BY listing_id, available ORDER BY night_date) AS INTEGER) AS run_key
       FROM kept
     ),
     sized AS (
       SELECT *, count(*) OVER (PARTITION BY listing_id, available, run_key) AS run_nights
       FROM grouped
     )
     SELECT
       listing_id,
       night_date,
       CAST(date_trunc('month', night_date) AS DATE) AS month,
       night_date < (SELECT latest_run_date FROM est_run_dates) AS is_past,
       CASE
         WHEN available THEN 'available'
         WHEN run_nights > ${BLOCK_RUN_NIGHTS} THEN 'blocked'
         WHEN ever_available THEN 'booked_observed'
         ELSE 'booked_inferred'
       END AS state
     FROM sized`,
  ],
  [
    // Quoted nightly price per listing per check-in month.
    'est_quotes',
    `CREATE OR REPLACE TABLE est_quotes AS
     SELECT
       listing_id,
       CAST(date_trunc('month', quote_check_in) AS DATE) AS month,
       count(*) AS quotes,
       median(quote_total / quote_nights) AS quoted_nightly
     FROM airbnb_listing_observations
     WHERE quote_total IS NOT NULL AND quote_nights > 0
     GROUP BY ALL`,
  ],
  [
    'est_listing_rate',
    `CREATE OR REPLACE TABLE est_listing_rate AS
     SELECT
       listing_id,
       median(quote_total / quote_nights) AS quoted_nightly
     FROM airbnb_listing_observations
     WHERE quote_total IS NOT NULL AND quote_nights > 0
     GROUP BY ALL`,
  ],
  [
    // One row per listing per month with calendar data.
    'est_listing_months',
    `CREATE OR REPLACE TABLE est_listing_months AS
     WITH counts AS (
       SELECT
         listing_id,
         month,
         bool_and(is_past) AS is_past,
         count(*) AS nights,
         count(*) FILTER (WHERE state = 'available') AS nights_available,
         count(*) FILTER (WHERE state = 'blocked') AS nights_blocked,
         count(*) FILTER (WHERE state = 'booked_observed') AS nights_booked_low,
         count(*) FILTER (WHERE state LIKE 'booked%') AS nights_booked,
         count(*) FILTER (WHERE state <> 'available') AS nights_booked_high
       FROM est_nights
       GROUP BY ALL
     )
     SELECT
       c.*,
       coalesce(q.quoted_nightly, r.quoted_nightly) AS nightly_rate,
       q.quoted_nightly IS NOT NULL AS rate_from_month,
       -- Occupancy is booked nights over nights offered (booked + available);
       -- the high bound counts every not-available night as booked.
       nights_booked_low / nullif(nights_available + nights_booked, 0) AS occupancy_low,
       nights_booked / nullif(nights_available + nights_booked, 0) AS occupancy,
       nights_booked_high / nullif(nights, 0) AS occupancy_high,
       nights_booked_low * coalesce(q.quoted_nightly, r.quoted_nightly) AS revenue_low,
       nights_booked * coalesce(q.quoted_nightly, r.quoted_nightly) AS revenue,
       nights_booked_high * coalesce(q.quoted_nightly, r.quoted_nightly) AS revenue_high
     FROM counts c
     LEFT JOIN est_quotes q USING (listing_id, month)
     LEFT JOIN est_listing_rate r USING (listing_id)`,
  ],
  [
    // Each listing seen on the latest run's version, with its host,
    // registration, parcel and the parcel's owner.
    'est_listings',
    `CREATE OR REPLACE TABLE est_listings AS
     WITH latest AS (
       SELECT *
       FROM listings
       QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY valid_from DESC) = 1
     ),
     joined AS (
       SELECT
         l.listing_id, l.name, l.url, l.listing_type, l.bedrooms, l.guest_capacity,
         l.host_id, l.is_active, l.registration_id, l.location_subtitle,
         l.location_lat, l.location_lng, l.location_is_exact,
         r.is_active AS registration_is_active,
         r.business_name AS registrant,
         r.registered_address,
         r.community_council,
         r.geocoded_lat, r.geocoded_lng,
         p.parcel_id, p.property_type AS parcel_property_type,
         p.total_living_units, p.owner_name, p.owner_city, p.owner_state,
         p.exemption_types_all, p.appraised_total_value
       FROM latest l
       LEFT JOIN registrations r USING (registration_id)
       LEFT JOIN property_parcels p ON p.parcel_id = r.parcel_id
     )
     SELECT
       *,
       coalesce(geocoded_lat, location_lat) AS lat,
       coalesce(geocoded_lng, location_lng) AS lng,
       ${COUNCIL_AREA} AS area,
       CASE
         WHEN listing_type = 'entire_home' THEN 'Entire home'
         WHEN listing_type IN ('private_room', 'shared_room') THEN 'Room'
         WHEN listing_type = 'hotel_room' THEN 'Hotel room'
         ELSE 'Unknown'
       END AS listing_kind,
       try_cast(regexp_extract(bedrooms, '^(\\d+)', 1) AS INTEGER) AS bedroom_count,
       CASE
         WHEN owner_name IS NULL THEN 'Unknown'
         WHEN regexp_matches(owner_name, '\\b(LLC|L L C|INC|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|PARTNERS|PARTNERSHIP|HOLDINGS|PROPERTIES|ENTERPRISES|INVESTMENTS|ASSN|ASSOCIATION|GROUP)\\b') THEN 'Company'
         WHEN regexp_matches(owner_name, '\\b(TRUST|TRST|TR|TRUSTEE|TRUSTEES|REVOCABLE|LIVING TR)\\b') THEN 'Trust'
         ELSE 'Individual'
       END AS owner_kind,
       CASE
         WHEN owner_name IS NULL THEN 'Unknown'
         WHEN upper(trim(owner_state)) = 'AK' AND upper(trim(owner_city)) IN (${MUNI_CITIES.map((c) => `'${c}'`).join(', ')}) THEN 'In the Muni'
         WHEN upper(trim(owner_state)) = 'AK' THEN 'Elsewhere in Alaska'
         ELSE 'Outside Alaska'
       END AS owner_mailing,
       coalesce(exemption_types_all ILIKE '%PRIMARY RES%', false) AS owner_occupied_exemption
     FROM joined`,
  ],
  FREHM_STATEMENT,
];

/** The tables the story reads, for the error message when one is missing. */
export const ESTIMATE_TABLES = ESTIMATE_STATEMENTS.map(([table]) => table);
