-- Queries behind README.md. Run against data/anchorage_str.duckdb:
--   duckdb -readonly data/anchorage_str.duckdb < docs/research/combo-listings/queries.sql
-- Results change with every run. README.md quotes the 2026-09-26 run.

LOAD spatial;
-- Points below are built as ST_Point(lat, lng), which ST_Distance_Sphere
-- reads as latitude first when this is false.
SET geometry_always_xy = false;

-- Setup 1: every active listing's current calendar from the latest run on,
-- with each night's not-available run. A run is a stretch of consecutive
-- not-available nights. An interior run starts after the first night of the
-- window and ends before the last, so both of its edges are observed.
CREATE OR REPLACE TEMP TABLE nights AS
WITH c AS (
    SELECT listing_id, night_date, NOT available AS not_available
    FROM calendar_current
    WHERE night_date >= (SELECT scrape_date FROM latest_scrape_date)
      AND listing_id IN (SELECT listing_id FROM listings_active)
), numbered AS (
    SELECT
        *,
        sum(changed) OVER (PARTITION BY listing_id ORDER BY night_date) AS run_no
    FROM (
        SELECT
            *,
            (not_available IS DISTINCT FROM lag(not_available) OVER (PARTITION BY listing_id ORDER BY night_date))::int AS changed
        FROM c
    )
), bounded AS (
    SELECT
        *,
        min(night_date) OVER w AS run_start,
        max(night_date) OVER w AS run_end
    FROM numbered
    WINDOW w AS (PARTITION BY listing_id, run_no)
)
SELECT
    listing_id,
    night_date,
    not_available,
    run_no,
    not_available
        AND run_start > (SELECT min(night_date) FROM c)
        AND run_end < (SELECT max(night_date) FROM c) AS in_interior_run
FROM bounded;

CREATE OR REPLACE TEMP TABLE interior_runs AS
SELECT listing_id, run_no, min(night_date) AS run_start, max(night_date) AS run_end
FROM nights
WHERE in_interior_run
GROUP BY ALL;

-- Setup 2: active listings with bedrooms as a number. Studio is 0, and a room
-- listing with no bedroom count is 1.
CREATE OR REPLACE TEMP TABLE sized AS
SELECT
    listing_id,
    host_id,
    name,
    listing_type,
    registration_id,
    location_lat,
    location_lng,
    coalesce(
        CASE WHEN bedrooms = 'Studio' THEN 0 ELSE try_cast(split_part(bedrooms, ' ', 1) AS int) END,
        1
    ) AS bedrooms_n,
    guest_capacity
FROM listings_active;

-- Setup 3: candidate pairs. Every ordered pair of active listings within
-- 500 m of each other or showing the same registration id, where the first
-- (the candidate combo) has more bedrooms than the second (the candidate
-- component).
CREATE OR REPLACE TEMP TABLE candidate_pairs AS
SELECT
    c.listing_id AS combo_listing_id,
    k.listing_id AS component_listing_id,
    c.host_id = k.host_id AS same_host,
    coalesce(c.registration_id = k.registration_id, false) AS same_registration,
    ST_Distance_Sphere(
        ST_Point(c.location_lat, c.location_lng),
        ST_Point(k.location_lat, k.location_lng)
    ) AS meters,
    c.bedrooms_n AS combo_bedrooms,
    k.bedrooms_n AS component_bedrooms,
    c.name AS combo_name,
    k.name AS component_name
FROM sized c
JOIN sized k
  ON c.listing_id <> k.listing_id
 AND c.bedrooms_n > k.bedrooms_n
 AND (
        c.registration_id = k.registration_id
        OR ST_Distance_Sphere(
            ST_Point(c.location_lat, c.location_lng),
            ST_Point(k.location_lat, k.location_lng)
        ) <= 500
     );

-- Setup 4: calendar evidence per candidate pair.
--   violations: nights the component is not available and the combo is.
--     A true component has none: while it is taken, the combo cannot be.
--   matched_runs: the component's interior runs that the combo repeats
--     exactly, not available on every night of the run and available on
--     the night before and the night after.
CREATE OR REPLACE TEMP TABLE pair_evidence AS
WITH night_counts AS (
    SELECT
        p.combo_listing_id,
        p.component_listing_id,
        count(*) FILTER (WHERE k.not_available) AS component_not_available,
        count(*) FILTER (WHERE c.not_available) AS combo_not_available,
        count(*) FILTER (WHERE k.not_available AND NOT c.not_available) AS violations
    FROM candidate_pairs p
    JOIN nights c ON c.listing_id = p.combo_listing_id
    JOIN nights k ON k.listing_id = p.component_listing_id AND k.night_date = c.night_date
    GROUP BY ALL
), run_counts AS (
    SELECT
        p.combo_listing_id,
        p.component_listing_id,
        count(*) AS component_interior_runs,
        count(*) FILTER (WHERE covered.all_not_available AND before.not_available = false AND after.not_available = false) AS matched_runs
    FROM candidate_pairs p
    JOIN interior_runs r ON r.listing_id = p.component_listing_id
    JOIN LATERAL (
        SELECT bool_and(n.not_available) AS all_not_available
        FROM nights n
        WHERE n.listing_id = p.combo_listing_id AND n.night_date BETWEEN r.run_start AND r.run_end
    ) covered ON true
    LEFT JOIN nights before ON before.listing_id = p.combo_listing_id AND before.night_date = r.run_start - 1
    LEFT JOIN nights after ON after.listing_id = p.combo_listing_id AND after.night_date = r.run_end + 1
    GROUP BY ALL
)
SELECT
    p.*,
    n.component_not_available,
    n.combo_not_available,
    n.violations,
    coalesce(r.component_interior_runs, 0) AS component_interior_runs,
    coalesce(r.matched_runs, 0) AS matched_runs,
    regexp_matches(
        p.combo_name,
        '(?i)\bcombo\b|compound|full (duplex|house|building|home)|entire (duplex|building)|entire apts|whole house|both units|\d+[ -]units?\b|two units|adjoining|houses in 1|double house'
    ) AS combo_name_says_combo
FROM candidate_pairs p
JOIN night_counts n USING (combo_listing_id, component_listing_id)
LEFT JOIN run_counts r USING (combo_listing_id, component_listing_id);

-- Setup 5: the detection rule, in three steps.
--   linked: same host, at most 2 violations, at least 1 matched run.
--   strong: linked, and 2+ matched runs, or the same registration id, or a
--     combo name that says it combines units.
--   sibling: a strong pair whose component is also a strong component of a
--     bigger listing, and whose combo name does not say combo. Two dwellings
--     of one combo share every run the combo puts on both, so the bigger of
--     the two can look like it covers the smaller.
CREATE OR REPLACE TEMP TABLE detected AS
WITH linked AS (
    SELECT
        *,
        matched_runs >= 2 OR same_registration OR combo_name_says_combo AS strong
    FROM pair_evidence
    WHERE same_host AND violations <= 2 AND matched_runs >= 1
)
SELECT
    l.*,
    l.strong AND NOT l.combo_name_says_combo AND EXISTS (
        SELECT 1
        FROM linked o
        WHERE o.strong
          AND o.component_listing_id = l.component_listing_id
          AND o.combo_listing_id <> l.combo_listing_id
          AND o.combo_bedrooms > l.combo_bedrooms
    ) AS sibling
FROM linked l;

-- Setup 6: hand-checked verdicts for every linked pair, from the two names,
-- bedrooms, registration ids, distance and calendars. 'yes': the first
-- listing covers the second. 'no': it does not. 'unsure': cannot tell
-- without the listing pages.
CREATE OR REPLACE TEMP TABLE verdicts (combo_listing_id BIGINT, component_listing_id BIGINT, verdict VARCHAR, note VARCHAR);
INSERT INTO verdicts VALUES
    (3457665, 13416604, 'yes', 'The Jules: whole house covers its suites'),
    (3457665, 13416897, 'yes', 'The Jules: whole house covers its rooms'),
    (3457665, 13416993, 'yes', 'The Jules: whole house covers its rooms'),
    (36810756, 28561644, 'yes', '"3 units" covers the log cabin'),
    (48492935, 48531882, 'yes', 'Goldenview Retreat covers its suites'),
    (48492935, 48532605, 'yes', 'Goldenview Retreat covers its suites'),
    (48492935, 48532925, 'yes', 'Goldenview Retreat covers its suites'),
    (52171847, 1029049707266083713, 'no', 'numbered cottages #1 and #4 of one lot'),
    (52171847, 1344400160707162853, 'no', 'numbered cottages #1 and #3 of one lot'),
    (53574551, 53560259, 'yes', '2-Unit Chalet, 3 + 2 bedrooms'),
    (53574551, 53573226, 'yes', '2-Unit Chalet, 3 + 2 bedrooms'),
    (603643425786065443, 619617530097395388, 'no', 'Lark St: separate apartments'),
    (603643425786065443, 619620258985541322, 'no', 'Lark St: separate apartments'),
    (647038672219247651, 989940972825044148, 'unsure', 'Creekside home and getaway, 5 m apart'),
    (650703417901647620, 650740675048189290, 'unsure', 'both not available on 95% of nights'),
    (656318860846776577, 645953498616566832, 'yes', 'M St 3BR Combo covers the 2-bedroom unit'),
    (669776495319133526, 934124969732923338, 'unsure', 'two private-room listings, same calendar'),
    (671080169206801340, 646665488318641326, 'yes', 'Double house, 2 + 1 bedrooms'),
    (671080169206801340, 671024040847617580, 'yes', 'Double house, 2 + 1 bedrooms'),
    (710295528067536426, 710134390747537081, 'yes', 'Full Duplex covers each unit'),
    (710295528067536426, 710280902480078850, 'yes', 'Full Duplex covers each unit'),
    (720964186611110453, 645953498616566832, 'yes', 'M St compound'),
    (720964186611110453, 656318860846776577, 'yes', 'M St compound covers the 3BR Combo'),
    (720964186611110453, 671779791243926274, 'yes', 'M St compound'),
    (781561466237821991, 558100013878090934, 'yes', '5-bedroom home = 3-bedroom home + 2-bedroom den'),
    (817510656719871504, 43819678, 'yes', 'Moose Meadows Retreat, 4 + 2 bedrooms'),
    (817510656719871504, 815508132639490169, 'yes', 'Moose Meadows Retreat, 4 + 2 bedrooms'),
    (832278111770365732, 52962848, 'yes', 'Hygge House, "2 houses in 1"'),
    (832278111770365732, 643585266500303881, 'yes', 'Hygge House, "2 houses in 1"'),
    (887643899331468364, 913172015910046359, 'unsure', 'same estate at 6 and 5 bedrooms: combo or duplicate'),
    (919850596440235634, 895698700582986490, 'yes', 'Denali Double House 3BR combo'),
    (919861119846421474, 646665488318641326, 'yes', 'AK Village 4 unit combo'),
    (919861119846421474, 671024040847617580, 'yes', 'AK Village 4 unit combo'),
    (919861119846421474, 671080169206801340, 'yes', 'AK Village 4 unit combo'),
    (919861119846421474, 895698700582986490, 'yes', 'AK Village 4 unit combo'),
    (919861119846421474, 919850596440235634, 'yes', 'AK Village 4 unit combo'),
    (931516596054392776, 926393948479107688, 'yes', 'whole house covers the upstairs'),
    (1006155302402631638, 558100013878090934, 'no', 'siblings: both are inside the 5-bedroom home'),
    (1090787477362025576, 1065229005043567494, 'unsure', 'Chugiak chalets, sizes do not add up'),
    (1090787477362025576, 1111031610266983019, 'unsure', 'Chugiak chalets, sizes do not add up'),
    (1111031610266983019, 1065229005043567494, 'unsure', 'Chugiak chalets, sizes do not add up'),
    (1180843982302113904, 1127174659635399159, 'yes', 'house + studio covers the house'),
    (1197715784748015844, 1206608243376149637, 'yes', 'Monarch Estate covers the lower level'),
    (1197715784748015844, 1206608250708549650, 'yes', 'Monarch Estate covers the upper level'),
    (1206608250708549650, 1206608243376149637, 'no', 'siblings: upper and lower level'),
    (1235049055699961332, 1694422977155081248, 'yes', 'Grand Estate at 8 and 5+ bedrooms'),
    (1267640044563959459, 1261077912615714433, 'unsure', 'duplex units and a studio at one pin'),
    (1267735970296435055, 1261077912615714433, 'unsure', 'duplex units and a studio at one pin'),
    (1314700001186516881, 1314677612156468239, 'no', 'two apartments in one building'),
    (1369900679626004459, 1366269444071895718, 'yes', '"Suite and Cabin" covers the cabin'),
    (1373566734504523791, 33803798, 'yes', 'Grand Home Villa, 4 + 2 bedrooms'),
    (1373566734504523791, 608445027482501945, 'yes', 'Grand Home Villa, 4 + 2 bedrooms'),
    (1389088991427055146, 1645858104151900961, 'no', 'two ski-in condos, property manager'),
    (1435649395378335376, 675365378770632243, 'unsure', 'Moose Meadow 3b/3b and a 1-bedroom'),
    (1488720157353920442, 1488718211989712311, 'no', 'Arbor du Nord apartments 1B and 1A'),
    (1506589954006831604, 1506656780831589146, 'yes', 'Duplex for 16+, 3 + 2 bedrooms'),
    (1506589954006831604, 1506670448455178934, 'yes', 'Duplex for 16+, 3 + 2 bedrooms'),
    (1506670448455178934, 1506656780831589146, 'no', 'siblings: the two townhomes of the duplex'),
    (1627750104313503229, 843453113073260077, 'yes', 'Entire Duplex, 2 + 2 bedrooms'),
    (1627750104313503229, 1577709087926261623, 'yes', 'Entire Duplex, 2 + 2 bedrooms'),
    (1650797199392143518, 51902855, 'yes', '2 Adjoining Condos'),
    (1650797199392143518, 675919597906848951, 'yes', '2 Adjoining Condos'),
    (1666150309545055104, 1211595658386858862, 'unsure', 'group getaway and a 2-bedroom at one pin'),
    (1671759924941130693, 1614545221246831723, 'yes', 'Cabin Duplex covers the Raven cabin'),
    (1703960498804079878, 1703929629875697758, 'unsure', 'Anchorage Villa 3- and 2-bedroom'),
    (1756851965405362688, 1756785504151312235, 'unsure', 'lakeside house and studio, one run');

-- §1: the M St listings, their calendars and the evidence between them.
SELECT listing_id, bedrooms, guest_capacity, name
FROM listings_active
WHERE host_id = 187849202 AND registration_id = 'STR20261828'
ORDER BY listing_id;

SELECT listing_id, string_agg(CASE WHEN not_available THEN '#' ELSE '.' END, '' ORDER BY night_date) AS calendar
FROM nights
WHERE listing_id IN (645953498616566832, 671779791243926274, 645953306917476922, 656318860846776577, 720964186611110453)
GROUP BY 1;

SELECT listing_id, max(night_date) FILTER (WHERE run_no = 1) AS first_run_ends
FROM nights
WHERE listing_id IN (645953498616566832, 671779791243926274, 645953306917476922, 656318860846776577, 720964186611110453)
GROUP BY 1;

SELECT n.listing_id, min(n.night_date) AS run_start, max(n.night_date) AS run_end
FROM nights n
WHERE n.in_interior_run
  AND n.listing_id IN (645953498616566832, 671779791243926274, 645953306917476922, 656318860846776577, 720964186611110453)
GROUP BY n.listing_id, n.run_no
ORDER BY run_start, n.listing_id;

SELECT combo_listing_id, component_listing_id, round(meters) AS meters, violations, component_interior_runs, matched_runs
FROM pair_evidence
WHERE combo_listing_id IN (656318860846776577, 720964186611110453)
  AND component_listing_id IN (645953498616566832, 671779791243926274, 645953306917476922, 656318860846776577, 720964216940577112)
ORDER BY 1, 2;

-- §2: active listings, nights per calendar, and the share of nights not available.
SELECT
    (SELECT count(*) FROM listings_active) AS active_listings,
    count(DISTINCT listing_id) AS with_calendar,
    count(*) / count(DISTINCT listing_id) AS nights_each,
    min(night_date) AS first_night,
    max(night_date) AS last_night,
    round(avg(not_available::int), 2) AS share_not_available
FROM nights;

-- §2: candidate pairs, and how many pass the linked rule, same host or not.
-- Pairs across hosts are almost never combos, so the second row is the
-- rate at which the rule links unrelated calendars.
SELECT
    same_host,
    count(*) AS candidate_pairs,
    count(*) FILTER (WHERE violations <= 2 AND matched_runs >= 1) AS linked,
    count(*) FILTER (WHERE violations <= 2 AND matched_runs >= 1
                       AND (matched_runs >= 2 OR same_registration OR combo_name_says_combo)) AS strong
FROM pair_evidence
GROUP BY 1
ORDER BY 1;

-- §2: the cross-host pairs the rule would link, for inspection.
SELECT combo_listing_id, component_listing_id, same_registration, round(meters) AS meters,
       violations, matched_runs, combo_name, component_name
FROM pair_evidence
WHERE NOT same_host AND violations <= 2 AND matched_runs >= 1
ORDER BY matched_runs DESC;

-- §3: precision by step.
SELECT
    CASE
        WHEN NOT d.strong THEN '1 linked, not strong'
        WHEN d.sibling THEN '2 strong, sibling'
        ELSE '3 strong, not sibling'
    END AS step,
    count(*) AS pairs,
    count(*) FILTER (WHERE v.verdict = 'yes') AS yes,
    count(*) FILTER (WHERE v.verdict = 'no') AS no,
    count(*) FILTER (WHERE v.verdict = 'unsure') AS unsure
FROM detected d
LEFT JOIN verdicts v USING (combo_listing_id, component_listing_id)
GROUP BY 1
ORDER BY 1;

-- §3: every linked pair with its evidence and verdict.
SELECT
    d.combo_listing_id,
    d.component_listing_id,
    d.strong,
    d.sibling,
    v.verdict,
    d.same_registration,
    round(d.meters) AS meters,
    d.combo_bedrooms,
    d.component_bedrooms,
    d.violations,
    d.matched_runs,
    left(replace(d.combo_name, chr(10), ' '), 45) AS combo_name,
    left(replace(d.component_name, chr(10), ' '), 45) AS component_name,
    v.note
FROM detected d
LEFT JOIN verdicts v USING (combo_listing_id, component_listing_id)
ORDER BY d.strong DESC, d.sibling, v.verdict, d.combo_listing_id;

-- §4: the accepted pairs (strong, not sibling), as combos, components and
-- atomic listings. An atomic component covers no other accepted component.
CREATE OR REPLACE TEMP TABLE accepted AS
SELECT * FROM detected WHERE strong AND NOT sibling;

SELECT
    count(*) AS pairs,
    count(DISTINCT combo_listing_id) AS combo_listings,
    count(DISTINCT component_listing_id) AS component_listings,
    count(DISTINCT component_listing_id) FILTER (WHERE component_listing_id IN (SELECT combo_listing_id FROM accepted)) AS both_combo_and_component,
    (SELECT count(DISTINCT listing_id) FROM (
        SELECT combo_listing_id AS listing_id FROM accepted
        UNION SELECT component_listing_id FROM accepted
    )) AS listings_involved,
    (SELECT count(DISTINCT host_id) FROM listings_active WHERE listing_id IN (SELECT combo_listing_id FROM accepted)) AS hosts
FROM accepted;

-- §4: per top-level combo, the atomic listings it covers and whether their
-- bedrooms add up to the combo's.
WITH atomic AS (
    SELECT a.*
    FROM accepted a
    WHERE a.component_listing_id NOT IN (SELECT combo_listing_id FROM accepted)
)
SELECT
    a.combo_listing_id,
    any_value(a.combo_bedrooms) AS combo_bedrooms,
    count(*) AS atomic_listings,
    sum(a.component_bedrooms) AS atomic_bedrooms,
    any_value(a.combo_bedrooms) = sum(a.component_bedrooms) AS bedrooms_add_up,
    left(any_value(replace(a.combo_name, chr(10), ' ')), 45) AS combo_name
FROM atomic a
WHERE a.combo_listing_id NOT IN (SELECT component_listing_id FROM accepted)
GROUP BY 1
ORDER BY atomic_listings DESC, 1;

-- §4: not-available nights on the combo listings, which a count at the
-- grain of listings adds on top of their components' nights.
SELECT
    count(DISTINCT listing_id) AS combo_listings,
    count(*) FILTER (WHERE not_available) AS combo_not_available_nights,
    (SELECT count(*) FILTER (WHERE not_available) FROM nights) AS all_not_available_nights
FROM nights
WHERE listing_id IN (SELECT combo_listing_id FROM accepted);

-- §4: combo listings by whether their registration id is also shown by one
-- of their components. A combo with an id of its own has a registration
-- for a space the component registrations already cover.
WITH c AS (
    SELECT
        a.combo_listing_id,
        any_value(cl.registration_id) AS combo_registration_id,
        bool_or(kl.registration_id = cl.registration_id) AS shared_with_component
    FROM accepted a
    JOIN listings_active cl ON cl.listing_id = a.combo_listing_id
    JOIN listings_active kl ON kl.listing_id = a.component_listing_id
    GROUP BY 1
)
SELECT
    CASE
        WHEN combo_registration_id IS NULL THEN 'combo shows no id'
        WHEN shared_with_component THEN 'shared with a component'
        ELSE 'its own id'
    END AS combo_registration,
    count(*) AS combo_listings,
    list(combo_registration_id ORDER BY combo_registration_id) AS registration_ids
FROM c
GROUP BY 1
ORDER BY 1;

-- §5: listings whose name says they combine units, and whether the rule
-- found components for them. A recall check the rule did not use to choose
-- its thresholds. The rule does use the name, but only to promote a pair
-- the calendars already linked.
WITH named AS (
    SELECT *
    FROM sized
    WHERE regexp_matches(
        name,
        '(?i)\bcombo\b|compound|full (duplex|house|building|home)|entire (duplex|building)|entire apts|whole house|both units|\d+[ -]units?\b|two units|adjoining|houses in 1|double house'
    )
)
SELECT
    n.listing_id,
    n.bedrooms_n AS bedrooms,
    left(replace(n.name, chr(10), ' '), 50) AS name,
    (SELECT count(*) FROM pair_evidence p WHERE p.combo_listing_id = n.listing_id AND p.same_host) AS same_host_candidates,
    (SELECT count(*) FROM pair_evidence p WHERE p.combo_listing_id = n.listing_id AND p.same_host AND p.violations <= 2) AS at_most_2_violations,
    (SELECT count(*) FROM pair_evidence p WHERE p.combo_listing_id = n.listing_id AND p.same_host AND p.violations <= 2 AND p.component_interior_runs > 0) AS testable,
    (SELECT count(*) FROM accepted a WHERE a.combo_listing_id = n.listing_id) AS accepted_components
FROM named n
ORDER BY accepted_components DESC, same_host_candidates DESC;

-- §5: same-host pairs with no violations whose component has no interior
-- run, so the calendar cannot test them.
SELECT
    count(*) FILTER (WHERE violations <= 2) AS at_most_2_violations,
    count(*) FILTER (WHERE violations <= 2 AND component_interior_runs = 0) AS untestable
FROM pair_evidence
WHERE same_host;

-- §6: the proposed view, as a temp view. README.md quotes it as CREATE VIEW.
CREATE OR REPLACE TEMP VIEW listing_components AS
WITH window_nights AS (
    SELECT listing_id, night_date, NOT available AS not_available, (listing_id, night_date) AS listing_night
    FROM calendar_current
    WHERE night_date >= (SELECT scrape_date FROM latest_scrape_date)
      AND listing_id IN (SELECT listing_id FROM listings_active)
),
runs AS (
    -- Interior not-available runs: both edges inside the window.
    SELECT listing_id, min(night_date) AS run_start, max(night_date) AS run_end
    FROM (
        SELECT *, sum(changed) OVER (PARTITION BY listing_id ORDER BY night_date) AS run_no
        FROM (
            SELECT *, (not_available IS DISTINCT FROM lag(not_available)
                OVER (PARTITION BY listing_id ORDER BY night_date))::int AS changed
            FROM window_nights
        )
    )
    WHERE not_available
    GROUP BY listing_id, run_no
    HAVING min(night_date) > (SELECT min(night_date) FROM window_nights)
       AND max(night_date) < (SELECT max(night_date) FROM window_nights)
),
sized AS (
    SELECT
        listing_id, host_id, name, registration_id, location_lat, location_lng,
        coalesce(CASE WHEN bedrooms = 'Studio' THEN 0
                      ELSE try_cast(split_part(bedrooms, ' ', 1) AS int) END, 1) AS bedrooms_n
    FROM listings_active
),
pairs AS (
    -- Same host, bigger combo, same registration id or within 500 m.
    SELECT *
    FROM (
        SELECT
            c.listing_id AS combo_listing_id,
            k.listing_id AS component_listing_id,
            coalesce(c.registration_id = k.registration_id, false) AS same_registration,
            2 * 6371000 * asin(sqrt(
                pow(sin(radians(k.location_lat - c.location_lat) / 2), 2)
                + cos(radians(c.location_lat)) * cos(radians(k.location_lat))
                  * pow(sin(radians(k.location_lng - c.location_lng) / 2), 2)
            )) AS meters,
            c.bedrooms_n AS combo_bedrooms,
            k.bedrooms_n AS component_bedrooms,
            regexp_matches(c.name, '(?i)\bcombo\b|compound|full (duplex|house|building|home)|entire (duplex|building)|entire apts|whole house|both units|\d+[ -]units?\b|two units|adjoining|houses in 1|double house') AS combo_name_says_combo
        FROM sized c
        JOIN sized k ON k.host_id = c.host_id
                    AND k.listing_id <> c.listing_id
                    AND c.bedrooms_n > k.bedrooms_n
    )
    WHERE same_registration OR meters <= 500
),
violations AS (
    SELECT p.combo_listing_id, p.component_listing_id,
           count(*) FILTER (WHERE k.not_available AND NOT c.not_available) AS violations
    FROM pairs p
    JOIN window_nights k ON k.listing_id = p.component_listing_id
    JOIN window_nights c ON c.listing_night = (p.combo_listing_id, k.night_date)
    GROUP BY ALL
),
matched AS (
    -- Component runs the combo repeats exactly: not available throughout,
    -- available the night before and the night after.
    SELECT combo_listing_id, component_listing_id, count(*) AS matched_runs
    FROM (
        SELECT p.combo_listing_id, p.component_listing_id, r.run_start
        FROM pairs p
        JOIN (
            SELECT *, unnest(generate_series(run_start - 1, run_end + 1, INTERVAL 1 DAY))::date AS night_date
            FROM runs
        ) r ON r.listing_id = p.component_listing_id
        JOIN window_nights n ON n.listing_night = (p.combo_listing_id, r.night_date)
        GROUP BY ALL
        HAVING count(*) = r.run_end - r.run_start + 3
           AND bool_and(n.not_available = (n.night_date BETWEEN r.run_start AND r.run_end))
    )
    GROUP BY ALL
),
strong AS (
    SELECT p.*, v.violations, m.matched_runs
    FROM pairs p
    JOIN violations v USING (combo_listing_id, component_listing_id)
    JOIN matched m USING (combo_listing_id, component_listing_id)
    WHERE v.violations <= 2
      AND (m.matched_runs >= 2 OR p.same_registration OR p.combo_name_says_combo)
)
-- Drop siblings: a pair whose component has a bigger strong combo, unless
-- this combo's name says it combines units.
SELECT * EXCLUDE (biggest_combo_bedrooms)
FROM (
    SELECT *, max(combo_bedrooms) OVER (PARTITION BY component_listing_id) AS biggest_combo_bedrooms
    FROM strong
)
WHERE combo_name_says_combo OR combo_bedrooms = biggest_combo_bedrooms;

-- §6: the view gives the same pairs as the accepted step above.
SELECT
    (SELECT count(*) FROM listing_components) AS view_pairs,
    count(*) AS pairs_in_only_one
FROM listing_components v
FULL JOIN accepted a USING (combo_listing_id, component_listing_id)
WHERE v.combo_listing_id IS NULL OR a.combo_listing_id IS NULL;

-- §6: derived metric, atomic listings each listing covers, by role.
WITH combos AS (
    SELECT
        combo_listing_id,
        count(*) FILTER (
            WHERE component_listing_id NOT IN (SELECT combo_listing_id FROM listing_components)
        ) AS atomic_listings
    FROM listing_components
    GROUP BY 1
), roles AS (
    SELECT
        l.listing_id,
        CASE WHEN c.combo_listing_id IS NULL THEN 'atomic' ELSE 'combo' END AS listing_role,
        coalesce(c.atomic_listings, 1) AS atomic_listings_covered
    FROM listings_active l
    LEFT JOIN combos c ON c.combo_listing_id = l.listing_id
)
SELECT listing_role, atomic_listings_covered, count(*) AS listings
FROM roles
GROUP BY ALL
ORDER BY ALL;
