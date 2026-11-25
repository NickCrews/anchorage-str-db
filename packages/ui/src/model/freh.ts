/**
 * Whether each listing is FREH or FREHM, as an estimate table the viewer
 * builds after the database loads. `CONTEXT.md` defines both terms.
 */

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

/**
 * One row per listing per model: whether it is FREHM, the counts the
 * test reads, and the reason in words. `is_freh` stays NULL until the
 * listing has a full window of past nights.
 *
 * TODO: test dwellings, not listings. A dwelling with several listings
 * counts once per listing, and a combo listing counts again on top of
 * its component listings, so the count of FREHM listings is not a count
 * of homes taken off the long-term market.
 */
export const FREHM_STATEMENT: [table: string, sql: string] = [
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
];
