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

/**
 * FREH, a Frequently Rented Entire-Home listing: over 365 nights, an
 * `Entire home/apt` listing open or booked at least `FREH_OFFERED_NIGHTS`
 * of them and booked at least `FREH_BOOKED_NIGHTS`.
 */
export const FREH_WINDOW_NIGHTS = 365;
export const FREH_OFFERED_NIGHTS = 183;
export const FREH_BOOKED_NIGHTS = 90;

/**
 * FREHM, FREH modified: the FREH test over the past nights on record, up to
 * `FREH_WINDOW_NIGHTS`, with both thresholds scaled to the nights on record.
 * A listing with fewer than this many has no answer. At a full window it is
 * FREH.
 */
export const FREHM_MIN_NIGHTS = 28;

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
         WHEN listing_type = 'Entire home/apt' THEN 'Entire home'
         WHEN listing_type IN ('Private room', 'Shared room') THEN 'Room'
         WHEN listing_type IS NULL THEN 'Unknown'
         ELSE 'Hotel room'
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
  [
    // One row per listing per model: whether it is FREHM, the counts the
    // test reads, and the reason in words. `is_freh` stays NULL until the
    // listing has a full window of past nights.
    //
    // TODO: test dwellings, not listings. A dwelling with several listings
    // counts once per listing, and a combo listing counts again on top of
    // its component listings, so the count of FREHM listings is not a count
    // of homes taken off the long-term market.
    'est_listing_frehm',
    `CREATE OR REPLACE TABLE est_listing_frehm AS
     WITH window_counts AS (
       SELECT
         listing_id,
         min(night_date) AS first_night,
         max(night_date) AS last_night,
         count(*) AS nights,
         count(*) FILTER (WHERE state = 'available') AS nights_available,
         count(*) FILTER (WHERE state = 'booked_observed') AS nights_booked_observed,
         count(*) FILTER (WHERE state = 'booked_inferred') AS nights_booked_inferred
       FROM est_nights
       WHERE is_past
         AND night_date >= (SELECT latest_run_date - ${FREH_WINDOW_NIGHTS} FROM est_run_dates)
       GROUP BY listing_id
     ),
     models AS (
       SELECT * FROM (VALUES ('low'), ('middle'), ('high')) AS t(model)
     ),
     counted AS (
       SELECT
         l.listing_id,
         m.model,
         l.listing_type,
         w.first_night,
         w.last_night,
         coalesce(w.nights, 0) AS nights,
         coalesce(w.nights_available, 0) AS nights_available,
         CASE m.model
           WHEN 'low' THEN coalesce(w.nights_booked_observed, 0)
           WHEN 'middle' THEN coalesce(w.nights_booked_observed + w.nights_booked_inferred, 0)
           ELSE coalesce(w.nights - w.nights_available, 0)
         END AS nights_booked
       FROM est_listings l
       CROSS JOIN models m
       LEFT JOIN window_counts w USING (listing_id)
     ),
     tested AS (
       SELECT
         *,
         nights_available + nights_booked AS nights_offered,
         CAST(ceil(${FREH_OFFERED_NIGHTS} * nights / ${FREH_WINDOW_NIGHTS}) AS INTEGER) AS nights_offered_needed,
         CAST(ceil(${FREH_BOOKED_NIGHTS} * nights / ${FREH_WINDOW_NIGHTS}) AS INTEGER) AS nights_booked_needed,
         listing_type = 'Entire home/apt' AS is_entire_home,
         nights >= ${FREHM_MIN_NIGHTS} AS has_enough_nights
       FROM counted
     ),
     decided AS (
       SELECT
         *,
         nights_offered >= nights_offered_needed AS meets_offered,
         nights_booked >= nights_booked_needed AS meets_booked,
         CASE
           WHEN listing_type IS NULL THEN NULL
           WHEN NOT is_entire_home THEN false
           WHEN NOT has_enough_nights THEN NULL
           ELSE meets_offered AND meets_booked
         END AS is_frehm
       FROM tested
     )
     SELECT
       *,
       CASE WHEN nights >= ${FREH_WINDOW_NIGHTS} THEN is_frehm END AS is_freh,
       CASE
         WHEN listing_type IS NULL THEN
           'Unknown: Airbnb does not say whether this is an entire home.'
         WHEN NOT is_entire_home THEN
           'Not FREHM: a ' || lower(listing_type) || ', not an entire home.'
         WHEN nights = 0 THEN
           'Unknown: no past nights on record.'
         WHEN NOT has_enough_nights THEN
           'Unknown: only ' || nights || ' past nights on record; it takes ${FREHM_MIN_NIGHTS}.'
         WHEN is_frehm THEN
           'FREHM: an entire home, open or booked ' || nights_offered || ' of ' || nights
             || ' nights (needs ' || nights_offered_needed || ') and booked ' || nights_booked
             || ' (needs ' || nights_booked_needed || ').'
         WHEN NOT meets_offered AND NOT meets_booked THEN
           'Not FREHM: open or booked only ' || nights_offered || ' of ' || nights
             || ' nights (needs ' || nights_offered_needed || '), and booked only ' || nights_booked
             || ' (needs ' || nights_booked_needed || ').'
         WHEN NOT meets_offered THEN
           'Not FREHM: open or booked only ' || nights_offered || ' of ' || nights
             || ' nights (needs ' || nights_offered_needed || '); closed by the owner the rest.'
         ELSE
           'Not FREHM: booked only ' || nights_booked || ' of ' || nights
             || ' nights (needs ' || nights_booked_needed || ').'
       END AS frehm_reason
     FROM decided`,
  ],
];

/** The tables the story reads, for the error message when one is missing. */
export const ESTIMATE_TABLES = ESTIMATE_STATEMENTS.map(([table]) => table);
