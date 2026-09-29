-- Queries behind README.md. Run against data/anchorage_str.duckdb:
--   duckdb -readonly data/anchorage_str.duckdb < docs/research/registration-inference/queries.sql
-- Results change with every run; README.md quotes the 2026-09-26 run.

LOAD spatial;
-- Points below are built as ST_Point(lat, lng), which ST_Distance_Sphere
-- reads as latitude first when this is false.
SET geometry_always_xy = false;

-- ---------------------------------------------------------------------------
-- Building blocks. Everything the rules use is defined once here, so the
-- proposed view and the validation run the same logic.
-- ---------------------------------------------------------------------------

-- A business name or listing title reduced to lowercase words, without
-- punctuation, "LLC", "Inc", "the" and similar.
CREATE OR REPLACE TEMP MACRO name_key(s) AS nullif(trim(regexp_replace(
    regexp_replace(lower(s), '[^a-z0-9]+', ' ', 'g'),
    '\b(llc|l l c|inc|ltd|co|company|the)\b', ' ', 'g')), '');

CREATE OR REPLACE TEMP TABLE ri_registrations AS
SELECT registration_id, business_name, name_key(business_name) AS name_key,
       registered_address, geocoded_lat, geocoded_lng
FROM registrations_active
WHERE geocoded_lat IS NOT NULL;

CREATE OR REPLACE TEMP TABLE ri_listings AS
SELECT l.listing_id, l.host_id, l.host_name, l.name, l.listing_type,
       l.location_is_exact AS is_exact, l.location_lat AS lat, l.location_lng AS lng,
       l.registration_id AS printed_id,
       r.registration_id IS NOT NULL AS printed_is_active,
       ST_Distance_Sphere(ST_Point(l.location_lat, l.location_lng),
                          ST_Point(r.geocoded_lat, r.geocoded_lng)) AS printed_m
FROM listings_active_with_host l
LEFT JOIN registrations_active r ON r.registration_id = l.registration_id;

-- How many active listings print each registration id.
CREATE OR REPLACE TEMP TABLE ri_citations AS
SELECT printed_id AS registration_id, count(*) AS listings
FROM ri_listings WHERE printed_id IS NOT NULL GROUP BY 1;

-- Registrations the same host prints on its other active listings.
CREATE OR REPLACE TEMP TABLE ri_host_registrations AS
SELECT DISTINCT l.listing_id, r.registration_id, r.name_key
FROM ri_listings l
JOIN ri_listings o ON o.host_id = l.host_id AND o.listing_id <> l.listing_id
JOIN ri_registrations r ON r.registration_id = o.printed_id;

-- Pairs of active registrations geocoded within 10 m of each other, which in
-- practice means the same address.
CREATE OR REPLACE TEMP TABLE ri_colocated AS
SELECT a.registration_id AS a, b.registration_id AS b
FROM ri_registrations a JOIN ri_registrations b
  ON a.registration_id <> b.registration_id
 AND abs(a.geocoded_lat - b.geocoded_lat) < 0.0002
 AND abs(a.geocoded_lng - b.geocoded_lng) < 0.0004
WHERE ST_Distance_Sphere(ST_Point(a.geocoded_lat, a.geocoded_lng),
                         ST_Point(b.geocoded_lat, b.geocoded_lng)) <= 10;

-- Every (listing, active registration) pair within 300 m, with the facts the
-- rules test. A listing's own printed id never counts as evidence: citations
-- are counted from other listings only, so hiding a listing's id (validation)
-- and a listing that prints none (the real case) look the same.
CREATE OR REPLACE TEMP TABLE ri_pairs AS
WITH near AS (
    SELECT l.listing_id, r.registration_id, r.name_key,
           ST_Distance_Sphere(ST_Point(l.lat, l.lng), ST_Point(r.geocoded_lat, r.geocoded_lng)) AS m
    FROM ri_listings l JOIN ri_registrations r
      ON r.geocoded_lat BETWEEN l.lat - 0.003 AND l.lat + 0.003
     AND r.geocoded_lng BETWEEN l.lng - 0.006 AND l.lng + 0.006
)
SELECT n.listing_id, n.registration_id, n.m, l.is_exact, l.listing_type,
       n.m <= CASE WHEN l.is_exact THEN 50 ELSE 200 END AS in_reach,
       coalesce(c.listings, 0) - (l.printed_id IS NOT DISTINCT FROM n.registration_id)::INT AS cited_by_others,
       EXISTS (SELECT 1 FROM ri_host_registrations h
               WHERE h.listing_id = n.listing_id AND h.registration_id = n.registration_id) AS cited_by_host,
       EXISTS (SELECT 1 FROM ri_host_registrations h
               WHERE h.listing_id = n.listing_id AND h.name_key = n.name_key) AS host_name_match,
       coalesce(n.name_key = p.name_key AND n.registration_id <> p.registration_id, false) AS printed_name_match,
       coalesce(length(n.name_key) >= 6 AND starts_with(name_key(l.name), n.name_key), false) AS title_match,
       -- other registrations at the same address that no other listing prints
       (SELECT count(*) FROM ri_colocated k
        LEFT JOIN ri_citations kc ON kc.registration_id = k.b
        WHERE k.a = n.registration_id
          AND coalesce(kc.listings, 0) - (l.printed_id IS NOT DISTINCT FROM k.b)::INT = 0) AS unclaimed_neighbours
FROM near n
JOIN ri_listings l USING (listing_id)
LEFT JOIN ri_citations c ON c.registration_id = n.registration_id
LEFT JOIN ri_registrations p ON p.registration_id = l.printed_id
WHERE n.m <= 300;

-- The rules. One row per (listing, rule) that fires, with the registration it
-- suggests. Two switches exist only for validation:
--   keep_printed      false drops the listing's printed registration from the
--                     candidates, simulating a listing whose registration is
--                     missing from the registry.
--   use_printed_name  false ignores the printed registration's business name,
--                     which on a correctly linked listing would leak the answer.
CREATE OR REPLACE TEMP MACRO ri_rule_hits(keep_printed, use_printed_name) AS TABLE
WITH p AS (
    SELECT p.* FROM ri_pairs p JOIN ri_listings l USING (listing_id)
    WHERE keep_printed OR p.registration_id IS DISTINCT FROM l.printed_id
),
per_listing AS (
    SELECT listing_id,
        any_value(is_exact) AS is_exact,
        any_value(listing_type) AS listing_type,
        -- title
        list(registration_id ORDER BY m) FILTER (WHERE in_reach AND title_match AND cited_by_others = 0) AS title_c,
        list(unclaimed_neighbours ORDER BY m) FILTER (WHERE in_reach AND title_match AND cited_by_others = 0) AS title_n,
        -- exact coordinate
        list(registration_id ORDER BY m) FILTER (WHERE m <= 30) AS exact_c,
        list(cited_by_others ORDER BY m) FILTER (WHERE m <= 30) AS exact_cited,
        list(unclaimed_neighbours ORDER BY m) FILTER (WHERE m <= 30) AS exact_n,
        list(cited_by_host ORDER BY m) FILTER (WHERE m <= 30) AS exact_host,
        -- host's business name
        list(registration_id ORDER BY m) FILTER (WHERE in_reach AND cited_by_others = 0
            AND (host_name_match OR (use_printed_name AND printed_name_match))) AS name_c,
        list(unclaimed_neighbours ORDER BY m) FILTER (WHERE in_reach AND cited_by_others = 0
            AND (host_name_match OR (use_printed_name AND printed_name_match))) AS name_n,
        bool_or(in_reach AND cited_by_host) AS host_cites_nearby
    FROM p GROUP BY listing_id
)
SELECT listing_id, 'title' AS rule, title_c[1] AS registration_id
FROM per_listing WHERE len(title_c) = 1 AND title_n[1] = 0
UNION ALL
SELECT listing_id, 'exact_coordinate', exact_c[1]
FROM per_listing WHERE is_exact AND len(exact_c) = 1 AND exact_cited[1] = 0 AND exact_n[1] = 0
UNION ALL
SELECT listing_id, 'sibling', name_c[1]
FROM per_listing WHERE len(name_c) = 1 AND name_n[1] = 0 AND NOT host_cites_nearby
UNION ALL
SELECT listing_id, 'room_sibling', exact_c[1]
FROM per_listing WHERE is_exact AND listing_type IN ('Private room', 'Shared room')
  AND len(exact_c) = 1 AND exact_host[1];

-- ---------------------------------------------------------------------------
-- Proposed view: listing_registration_suggestions.
-- ---------------------------------------------------------------------------

-- Which listings get a suggestion: no printed id; a printed id the registry
-- does not hold and that is not newer than the newest id it publishes; or a
-- printed id whose registration is more than 1 km away.
CREATE OR REPLACE TEMP VIEW ri_targets AS
SELECT listing_id,
       CASE WHEN printed_id IS NULL THEN 'no id'
            WHEN NOT printed_is_active THEN 'unknown id'
            ELSE 'over 1 km' END AS kind
FROM ri_listings
WHERE printed_id IS NULL
   OR (NOT printed_is_active
       AND printed_id <= (SELECT max(registration_id) FROM registrations_active))
   OR printed_m > 1000;

CREATE OR REPLACE TEMP VIEW listing_registration_suggestions AS
WITH hits AS (
    SELECT h.*,
           CASE h.rule WHEN 'title' THEN 1 WHEN 'exact_coordinate' THEN 2
                       WHEN 'room_sibling' THEN 3 WHEN 'sibling' THEN 4 END AS priority
    FROM ri_rule_hits(true, true) h
    JOIN ri_targets USING (listing_id)
),
-- rules that disagree about a listing cancel each other
agreed AS (
    SELECT listing_id, any_value(registration_id) AS registration_id,
           arg_min(rule, priority) AS rule, list(rule ORDER BY priority) AS rules
    FROM hits GROUP BY listing_id
    HAVING count(DISTINCT registration_id) = 1
),
-- a registration suggested to several listings stands only when they share a
-- host and at most one of them is an Entire home/apt
shared AS (
    SELECT a.registration_id
    FROM agreed a JOIN ri_listings l USING (listing_id)
    GROUP BY 1
    HAVING count(*) > 1
       AND (count(DISTINCT l.host_id) > 1
            OR count(*) FILTER (WHERE l.listing_type = 'Entire home/apt') > 1)
)
SELECT a.listing_id, a.registration_id, a.rule,
       CASE WHEN a.rule IN ('title', 'exact_coordinate') THEN 'high' ELSE 'medium' END AS confidence,
       round(p.m)::INTEGER AS distance_m,
       a.rules
FROM agreed a
JOIN ri_pairs p USING (listing_id, registration_id)
WHERE a.registration_id NOT IN (SELECT registration_id FROM shared);

-- ---------------------------------------------------------------------------
-- §1 Who needs a suggestion.
-- ---------------------------------------------------------------------------

-- Active listings by what their printed id links to.
SELECT CASE WHEN printed_id IS NULL THEN 'no id'
            WHEN NOT printed_is_active THEN 'id not in registry'
            WHEN printed_m IS NULL THEN 'registration not geocoded'
            WHEN printed_m <= 200 THEN 'within 200 m'
            WHEN printed_m <= 1000 THEN '200 m to 1 km'
            ELSE 'over 1 km' END AS link,
       count(*) AS listings,
       count(*) FILTER (WHERE is_exact) AS exact
FROM ri_listings GROUP BY 1 ORDER BY 2 DESC;

-- Printed ids the registry does not hold: how many are newer than the newest
-- id it publishes.
SELECT max(registration_id) AS newest_published,
       max(published_at) AS published_at,
       (SELECT count(*) FROM ri_listings WHERE NOT printed_is_active AND printed_id IS NOT NULL
          AND printed_id > (SELECT max(registration_id) FROM registrations_active)) AS newer,
       (SELECT count(*) FROM ri_listings WHERE NOT printed_is_active AND printed_id IS NOT NULL) AS not_in_registry
FROM registrations_active;

SELECT kind, count(*) AS listings FROM ri_targets GROUP BY 1 ORDER BY 2 DESC;

-- Distance from a linked listing's coordinate to its registration, exact vs
-- jittered, which sets the 30 m, 50 m and 200 m reaches.
SELECT is_exact, count(*) AS listings,
       round(quantile_cont(printed_m, 0.5)) AS median_m,
       round(quantile_cont(printed_m, 0.9)) AS p90_m,
       round(quantile_cont(printed_m, 0.95)) AS p95_m
FROM ri_listings WHERE printed_m <= 1000 GROUP BY 1;

-- ---------------------------------------------------------------------------
-- §3 Validation. Listings whose printed registration is within 200 m are
-- taken as correctly linked. Each rule runs with the listing's own id hidden
-- (it never counts as evidence), and is scored on whether it recovers it.
-- The second pass also deletes the listing's registration from the
-- candidates: every suggestion there is wrong, which is how a rule behaves on
-- a listing that has no registration at all.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TEMP TABLE ri_validation AS
SELECT listing_id, printed_id AS truth, is_exact FROM ri_listings WHERE printed_m <= 200;

SELECT count(*) AS listings, count(*) FILTER (WHERE is_exact) AS exact FROM ri_validation;

CREATE OR REPLACE TEMP TABLE ri_val_hits AS
SELECT h.*, v.truth FROM ri_rule_hits(true, false) h JOIN ri_validation v USING (listing_id);
CREATE OR REPLACE TEMP TABLE ri_val_removed_hits AS
SELECT h.* FROM ri_rule_hits(false, false) h JOIN ri_validation v USING (listing_id);

SELECT h.rule,
       count(*) AS suggested,
       count(*) FILTER (WHERE h.registration_id = h.truth) AS correct,
       round(100.0 * count(*) FILTER (WHERE h.registration_id = h.truth) / count(*), 1) AS precision_pct,
       (SELECT count(*) FROM ri_val_removed_hits r WHERE r.rule = h.rule) AS suggested_with_registration_removed
FROM ri_val_hits h GROUP BY 1 ORDER BY 1;

-- The same, after the view's priority and cancellation (not its shared-
-- registration check, which is about many listings at once).
WITH a AS (
    SELECT listing_id, any_value(registration_id) AS registration_id, any_value(truth) AS truth
    FROM ri_val_hits GROUP BY 1 HAVING count(DISTINCT registration_id) = 1
), r AS (
    SELECT listing_id FROM ri_val_removed_hits GROUP BY 1 HAVING count(DISTINCT registration_id) = 1
)
SELECT count(*) AS suggested,
       count(*) FILTER (WHERE registration_id = truth) AS correct,
       (SELECT count(*) FROM r) AS suggested_with_registration_removed
FROM a;

-- With the registration removed, what the wrong suggestion is: another
-- registration at the same address, or of the same registrant.
SELECT r.rule, count(*) AS suggested,
       count(*) FILTER (WHERE ST_Distance_Sphere(ST_Point(a.geocoded_lat, a.geocoded_lng),
                                                 ST_Point(t.geocoded_lat, t.geocoded_lng)) <= 10) AS same_address,
       count(*) FILTER (WHERE a.name_key = t.name_key) AS same_registrant
FROM ri_val_removed_hits r JOIN ri_validation v USING (listing_id)
JOIN ri_registrations a ON a.registration_id = r.registration_id
JOIN ri_registrations t ON t.registration_id = v.truth
GROUP BY 1 ORDER BY 1;

-- Every wrong validation suggestion, for reading.
SELECT h.rule, h.listing_id, l.name, h.registration_id, r.business_name, r.registered_address,
       h.truth, t.business_name AS truth_business_name, t.registered_address AS truth_address
FROM ri_val_hits h
JOIN ri_listings l USING (listing_id)
JOIN ri_registrations r ON r.registration_id = h.registration_id
JOIN ri_registrations t ON t.registration_id = h.truth
WHERE h.registration_id <> h.truth
ORDER BY h.rule, h.listing_id;

-- Candidate rules that were tried and dropped (§2). Each is the rule above
-- with one safeguard removed.
WITH p AS (
    SELECT p.*, v.truth FROM ri_pairs p JOIN ri_validation v USING (listing_id)
), per AS (
    SELECT listing_id, any_value(truth) AS truth, any_value(is_exact) AS is_exact,
        list(registration_id) FILTER (WHERE m <= 30) AS e_c,
        list(unclaimed_neighbours) FILTER (WHERE m <= 30) AS e_n,
        list(cited_by_others) FILTER (WHERE m <= 30 AND cited_by_others = 0) AS e_unc,
        list(registration_id) FILTER (WHERE m <= 30 AND cited_by_others = 0) AS e_unc_c,
        list(registration_id) FILTER (WHERE in_reach AND host_name_match) AS s_any,
        list(registration_id) FILTER (WHERE in_reach AND host_name_match AND NOT cited_by_host) AS s_new,
        list(registration_id) FILTER (WHERE in_reach AND title_match) AS t_any
    FROM p GROUP BY 1
)
SELECT 'exact: one uncited within 30 m, others cited' AS variant, count(*) AS suggested,
       count(*) FILTER (WHERE e_unc_c[1] = truth) AS correct
FROM per WHERE is_exact AND len(e_unc_c) = 1
UNION ALL
SELECT 'exact: without the same-address check', count(*), count(*) FILTER (WHERE e_c[1] = truth)
FROM per WHERE is_exact AND len(e_c) = 1 AND e_unc_c = e_c
UNION ALL
SELECT 'sibling: any registration with the name, even one the host prints', count(*), count(*) FILTER (WHERE s_any[1] = truth)
FROM per WHERE len(s_any) = 1
UNION ALL
SELECT 'sibling: a registration the host does not print, no other check', count(*), count(*) FILTER (WHERE s_new[1] = truth)
FROM per WHERE len(s_new) = 1
UNION ALL
SELECT 'title: already printed by another listing allowed', count(*), count(*) FILTER (WHERE t_any[1] = truth)
FROM per WHERE len(t_any) = 1;

-- Registrant name vs the Airbnb host's display name: how often they match.
SELECT count(DISTINCT l.host_id) AS hosts_whose_name_is_a_business_name,
       list(DISTINCT l.host_name) AS host_names
FROM ri_listings l JOIN ri_registrations r ON r.name_key = name_key(l.host_name);

-- ---------------------------------------------------------------------------
-- §4 What the view suggests on 2026-09-26.
-- ---------------------------------------------------------------------------

SELECT t.kind, s.rule, s.confidence, count(*) AS listings
FROM listing_registration_suggestions s JOIN ri_targets t USING (listing_id)
GROUP BY ALL ORDER BY ALL;

SELECT count(*) AS suggested, (SELECT count(*) FROM ri_targets) AS targets
FROM listing_registration_suggestions;

-- Rule hits on target listings before the view's priority, cancellation and
-- shared-registration check, and how many target listings are exact.
SELECT h.rule, count(*) AS listings
FROM ri_rule_hits(true, true) h JOIN ri_targets USING (listing_id)
GROUP BY 1 ORDER BY 1;
SELECT count(*) FILTER (WHERE l.is_exact) AS exact, count(*) AS listings
FROM ri_targets JOIN ri_listings l USING (listing_id);

-- Rule hits the view drops: rules disagreeing, or a registration suggested to
-- several listings.
WITH h AS (SELECT * FROM ri_rule_hits(true, true) JOIN ri_targets USING (listing_id))
SELECT h.listing_id, l.host_name, l.listing_type, l.name, list(DISTINCT h.rule) AS rules,
       list(DISTINCT h.registration_id) AS registrations
FROM h JOIN ri_listings l USING (listing_id)
WHERE h.listing_id NOT IN (SELECT listing_id FROM listing_registration_suggestions)
GROUP BY ALL ORDER BY l.host_name;

-- Every suggestion, for the hand check in §4.
SELECT s.listing_id, t.kind, s.rule, s.confidence, s.distance_m, l.listing_type, l.host_name, l.name,
       s.registration_id, r.business_name, r.registered_address, l.printed_id
FROM listing_registration_suggestions s
JOIN ri_targets t USING (listing_id)
JOIN ri_listings l USING (listing_id)
JOIN ri_registrations r USING (registration_id)
ORDER BY s.confidence, s.rule, s.registration_id;

-- A case the rules should decline: Shaligo's listing 1272688442355424229
-- prints STR20262410 (4425 E 6th Ave, room 4), and its exact coordinate is
-- 3 m from 3503 E 16th Ave, where the same registrant holds 10 registrations.
SELECT p.registration_id, r.registered_address, round(p.m) AS m, p.cited_by_others, p.unclaimed_neighbours
FROM ri_pairs p JOIN ri_registrations r USING (registration_id)
WHERE p.listing_id = 1272688442355424229 AND p.m <= 30 ORDER BY p.m, 1;
SELECT count(*) AS rule_hits FROM ri_rule_hits(true, true) WHERE listing_id = 1272688442355424229;
