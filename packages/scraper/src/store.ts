/**
 * DuckDB schema and merge logic.
 *
 * - `listing_observations`: append-only, one row per (listing, scrape date)
 *   with everything read that day from search and the listing page. The
 *   only stored facts about a listing.
 * - `calendar_status`: SCD2 on (listing_id, night_date). A night that leaves
 *   Airbnb's ~12-month calendar window is no longer observed, so its last
 *   value stays as the realized booked/available state.
 * - `listing_first_reviews`: one row per listing whose earliest review date
 *   has been resolved (see `firstReviews.ts`). Keyed by `listing_id` rather
 *   than a column on `listing_observations`, because it is resolved once:
 *   as a daily column it would be NULL on every row but one per listing.
 * - `listing_photos`: each listing's photo gallery, one row per distinct set,
 *   written only when the set differs from the listing's previous one.
 * - `host_observations`: append-only, one row per (host, scrape date) for
 *   every host owning a listing observed that day: the host card from the
 *   listing page. The `hosts` view is built from it the way `listings` is
 *   built from `listing_observations`.
 * - `scrape_runs`: one row per run.
 *
 * `calendar_status` is stored change-only because a daily snapshot would be
 * ~950k rows/day, and `listing_photos` because a gallery of ~20 URLs on every
 * daily row would grow the published database by hundreds of MB a year.
 * Listings are ~2600 rows/day, so they are stored daily and `listings` is a
 * view: `listing_versions` rebuilds `valid_from`/`valid_to`
 * with gaps-and-islands, and `listing_activity` derives first/last/page-seen
 * dates. Deriving keeps those dates consistent with the observations
 * (including for relisted listings) and lets a version-logic bug be fixed by
 * editing a view rather than backfilling the only copy of the archive.
 *
 * Listing-page fields share the row with the search fields so that
 * `location_is_exact` is readable next to `location_lat`/`location_lng`
 * without a join. A day whose page fetch failed stores `page_fetch_ok =
 * false` and NULLs; the view carries the last successful read forward.
 */

import {
  BIGINT,
  BOOLEAN,
  DATE,
  DOUBLE,
  INTEGER,
  LIST,
  VARCHAR,
  dateValue,
  listValue,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';

import type { CalendarResult } from '@anchorage-str-db/scraper-airbnb/calendars';
import type { FirstReviewCandidate, FirstReviewResult } from '@anchorage-str-db/scraper-airbnb/firstReviews';
import type { HostCard, Layer, ListingPage } from '@anchorage-str-db/scraper-airbnb/listingPage';
import { LAYERS } from '@anchorage-str-db/scraper-airbnb/listingPage';
import type { ParsedListing } from '@anchorage-str-db/scraper-airbnb/parse';
import type { PriceQuote } from '@anchorage-str-db/scraper-airbnb/priceQuotes';
import { addDays, epochDays, type IsoDate } from '@anchorage-str-db/utils/dates';

import * as config from './config.ts';
import { appendRow, Database } from './db.ts';
import { REGISTRY_SCHEMA_SQL, REGISTRY_VIEWS_SQL } from './registryStore.ts';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS listing_observations (
    listing_id BIGINT NOT NULL,
    scrape_date DATE NOT NULL,

    -- From the search response; present for every observed listing.
    name VARCHAR,
    property_title VARCHAR,
    location_lat DOUBLE,
    location_lng DOUBLE,
    url VARCHAR,
    badges VARCHAR[],

    -- These change most days, so they are not part of the version key.
    rating_value DOUBLE,
    review_count INTEGER,
    price_hint_per_night DOUBLE,
    price_qualifier VARCHAR,

    -- From the listing's own page, a separate request. \`page_fetch_ok\`
    -- distinguishes "read the page, no STR number" from "page not read";
    -- the columns below it are NULL when it is false.
    page_fetch_ok BOOLEAN NOT NULL,
    location_is_exact BOOLEAN,
    location_exact_address VARCHAR,
    location_subtitle VARCHAR,
    location_verified BOOLEAN,
    str_registration_id VARCHAR,
    -- The primary host's Airbnb user id (airbnb.com/users/show/<host_id>).
    host_id BIGINT,
    -- Airbnb's text, verbatim: 'Entire home/apt', 'Private room', ...
    room_type VARCHAR,
    guest_capacity INTEGER,
    -- Airbnb's bedCount; a bunk bed counts as 2.
    beds INTEGER,
    -- Overview lines, verbatim: '2 bedrooms', 'Studio'; '1.5 baths',
    -- 'Shared bathroom'.
    bedrooms VARCHAR,
    bathrooms VARCHAR,

    -- The price of one bookable stay (priceQuotes.ts): quote_total for
    -- quote_nights nights from quote_check_in. NULL when no stay was quoted.
    -- quote_label is Airbnb's text ('$241 for 2 nights, originally $269', or
    -- why there is no price); quote_breakdown its price-detail lines.
    quote_check_in DATE,
    quote_nights INTEGER,
    quote_total DOUBLE,
    quote_label VARCHAR,
    quote_breakdown VARCHAR[],

    PRIMARY KEY (listing_id, scrape_date)
);

CREATE TABLE IF NOT EXISTS calendar_status (
    listing_id BIGINT NOT NULL,
    night_date DATE NOT NULL,
    available BOOLEAN NOT NULL,
    min_nights INTEGER,
    status_hash VARCHAR NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    is_current BOOLEAN NOT NULL
);

-- The first URL is the cover photo. A set is current from valid_from until
-- the listing's next row.
CREATE TABLE IF NOT EXISTS listing_photos (
    listing_id BIGINT NOT NULL,
    valid_from DATE NOT NULL,
    photo_urls VARCHAR[] NOT NULL,

    PRIMARY KEY (listing_id, valid_from)
);

CREATE TABLE IF NOT EXISTS scrape_runs (
    scrape_date DATE NOT NULL,
    run_started_at TIMESTAMP NOT NULL,
    run_finished_at TIMESTAMP,
    listings_seen INTEGER,
    listings_new INTEGER,
    listings_changed INTEGER,
    listings_retired INTEGER,
    calendar_fetch_attempted INTEGER,
    calendar_fetch_failed INTEGER,
    calendar_nights_changed INTEGER,
    page_fetch_attempted INTEGER,
    page_fetch_failed INTEGER,
    error_summary VARCHAR
);

-- ALTERs rather than table columns, so an existing scrape_runs gains them.
-- NULL on runs that predate the pass they count.
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS first_review_fetch_attempted INTEGER;
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS first_review_fetch_failed INTEGER;
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS quote_fetch_attempted INTEGER;
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS quote_fetch_failed INTEGER;
-- Distinct hosts owning a listing observed this run, and how many of them
-- had no host card read.
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS host_profile_attempted INTEGER;
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS host_profile_failed INTEGER;

-- A row means the listing's reviews were read; a missing row means they
-- have not been yet. Failed fetches write no row and are retried next run.
-- Stores the date only: no review text or reviewer.
CREATE TABLE IF NOT EXISTS listing_first_reviews (
    listing_id BIGINT PRIMARY KEY,
    -- UTC date of the listing's oldest review; NULL if it had no reviews.
    first_review_date DATE,
    -- The scrape date of the run that read the reviews.
    resolved_date DATE NOT NULL
);

-- A host gets a row on every day one of their listings was observed,
-- including a day that listing's page failed, when the owner is known only
-- from the carried-forward host_id. \`profile_read_ok\` says whether any of
-- the host's listing pages yielded their card that day; the columns below it
-- are NULL when it is false.
CREATE TABLE IF NOT EXISTS host_observations (
    host_id BIGINT NOT NULL,
    scrape_date DATE NOT NULL,
    profile_read_ok BOOLEAN NOT NULL,
    -- A first name or a business name. Airbnb shows no surnames.
    name VARCHAR,
    -- The bio as the host wrote it. NULL on a read row means none.
    about VARCHAR,
    -- Airbnb's \`timeAsHost\` as of scrape_date. Airbnb publishes no start
    -- date; \`host_activity\` derives one.
    time_as_host_years INTEGER,
    time_as_host_months INTEGER,

    PRIMARY KEY (host_id, scrape_date)
);
`;

/**
 * The start date one `timeAsHost` reading implies. Airbnb reports whole
 * months, so this lands up to a month after the true start depending on the
 * day of the month it was read. `host_activity` takes the minimum over all
 * readings, which is why the start date is an aggregate rather than part of
 * the host version key.
 */
const IMPLIED_HOSTING_START_SQL =
  '(scrape_date - to_months(12 * time_as_host_years + time_as_host_months))::DATE';

/**
 * Attributes whose change opens a new listing version. Excludes values that
 * change most days (rating, review count, price hint) and `url`, which is
 * derived from `listing_id`. Coordinates are rounded to 6dp so float noise
 * doesn't open a version. `page` holds the listing-page fields, so a room
 * changing hands, converting from a whole home to a rented room, or changing
 * its guest, bed, bedroom or bathroom count opens a version. The price quote
 * changes most days and is not part of it. Photos are stored separately
 * and never open one: hosts reorder and replace photos far more often than
 * the listing itself changes.
 */
const VERSION_KEY_SQL = `{
    'name': name,
    'property_title': property_title,
    'lat': round(location_lat, 6),
    'lng': round(location_lng, 6),
    'badges': list_sort(badges),
    'page': page_attrs
}`;

const PAGE_ATTRS_SQL = `{
    'location_is_exact': location_is_exact,
    'location_exact_address': location_exact_address,
    'location_subtitle': location_subtitle,
    'location_verified': location_verified,
    'str_registration_id': str_registration_id,
    'host_id': host_id,
    'room_type': room_type,
    'guest_capacity': guest_capacity,
    'beds': beds,
    'bedrooms': bedrooms,
    'bathrooms': bathrooms
}`;

/**
 * `{grace}` is filled from `config.RETIREMENT_GRACE_DAYS`. The views are
 * recreated on every `connect()`, so a change to it applies on the next run.
 */
export const VIEWS_SQL = `
-- The date retirement is measured from: the latest run that completed its
-- writes. Observations alone would stop advancing on a day with no listings;
-- \`scrape_runs\` alone would include failed runs, whose counts are NULL.
CREATE OR REPLACE VIEW latest_scrape_date AS
SELECT max(scrape_date) AS scrape_date FROM (
    SELECT max(scrape_date) AS scrape_date FROM listing_observations
    UNION ALL
    SELECT max(scrape_date) AS scrape_date FROM scrape_runs
    WHERE listings_seen IS NOT NULL
);

-- Per listing: first and last seen, last successful page read, and whether
-- it is current. A listing is current if seen within RETIREMENT_GRACE_DAYS
-- of the latest scrape, because search occasionally omits a listing for a
-- day.
CREATE OR REPLACE VIEW listing_activity AS
SELECT
    listing_id,
    min(scrape_date) AS first_seen_date,
    max(scrape_date) AS last_seen_date,
    max(scrape_date) FILTER (WHERE page_fetch_ok) AS page_seen_date,
    max(scrape_date) >= (
        SELECT scrape_date FROM latest_scrape_date
    ) - INTERVAL {grace} DAY AS is_current
FROM listing_observations
GROUP BY listing_id;

-- SCD2 versions. A version runs from the first day an attribute set was
-- observed until the next distinct set appears.
CREATE OR REPLACE VIEW listing_versions AS
WITH observed AS (
    SELECT
        * EXCLUDE (
            location_is_exact, location_exact_address, location_subtitle,
            location_verified, str_registration_id, host_id,
            room_type, guest_capacity, beds, bedrooms, bathrooms
        ),
        -- NULL when the page fetch failed, so the carry-forward skips it.
        -- Carrying the whole struct keeps "read the page, no registration
        -- number" (a struct holding a NULL) distinct from "page not read"
        -- (a NULL struct).
        CASE WHEN page_fetch_ok THEN {page_attrs} END AS page_attrs
    FROM listing_observations
),
carried AS (
    SELECT * REPLACE (
        last_value(page_attrs IGNORE NULLS) OVER (
            PARTITION BY listing_id ORDER BY scrape_date
        ) AS page_attrs
    )
    FROM observed
),
keyed AS (
    SELECT *, {version_key} AS version_key FROM carried
),
marked AS (
    SELECT *,
        CASE WHEN version_key IS DISTINCT FROM lag(version_key) OVER w
             THEN 1 ELSE 0 END AS opens_version
    FROM keyed
    WINDOW w AS (PARTITION BY listing_id ORDER BY scrape_date)
),
numbered AS (
    SELECT *,
        sum(opens_version) OVER (PARTITION BY listing_id ORDER BY scrape_date)
            AS version_no
    FROM marked
),
-- Every row in a group has the same version_key, so any_value is exact.
aggregated AS (
    SELECT
        listing_id,
        version_no,
        min(scrape_date) AS valid_from,
        max(scrape_date) AS version_last_seen_date,
        any_value(name) AS name,
        any_value(property_title) AS property_title,
        any_value(location_lat) AS location_lat,
        any_value(location_lng) AS location_lng,
        any_value(url) AS url,
        any_value(badges) AS badges,
        any_value(page_attrs) AS page_attrs
    FROM numbered
    GROUP BY listing_id, version_no
)
SELECT
    * EXCLUDE (page_attrs),
    page_attrs.location_is_exact AS location_is_exact,
    page_attrs.location_exact_address AS location_exact_address,
    page_attrs.location_subtitle AS location_subtitle,
    page_attrs.location_verified AS location_verified,
    page_attrs.str_registration_id AS str_registration_id,
    page_attrs.host_id AS host_id,
    page_attrs.room_type AS room_type,
    page_attrs.guest_capacity AS guest_capacity,
    page_attrs.beds AS beds,
    page_attrs.bedrooms AS bedrooms,
    page_attrs.bathrooms AS bathrooms,
    lead(valid_from) OVER (PARTITION BY listing_id ORDER BY version_no) AS valid_to
FROM aggregated;

-- The dimension every downstream query reads.
CREATE OR REPLACE VIEW listings AS
SELECT
    v.listing_id,
    v.name,
    v.property_title,
    v.room_type,
    v.guest_capacity,
    v.beds,
    v.bedrooms,
    v.bathrooms,
    v.location_lat,
    v.location_lng,
    v.url,
    v.badges,
    v.location_is_exact,
    v.location_exact_address,
    v.location_subtitle,
    v.location_verified,
    v.str_registration_id,
    v.host_id,
    a.page_seen_date,
    a.first_seen_date,
    a.last_seen_date,
    r.first_review_date,
    -- The earlier of the first review and first_seen_date: the room was
    -- listed on or before this date. An estimate, not the true listing
    -- date: it can only be too late, never too early. A room with no
    -- reviews from before this project saw it gets first_seen_date and looks
    -- newer than it may be. \`least\` skips NULLs, so a listing with no
    -- reviews, or not yet resolved, gets first_seen_date.
    least(r.first_review_date, a.first_seen_date) AS first_available_date_est,
    v.version_no,
    v.version_last_seen_date,
    v.valid_from,
    v.valid_to,
    v.valid_to IS NULL AND a.is_current AS is_current
FROM listing_versions v
JOIN listing_activity a USING (listing_id)
LEFT JOIN listing_first_reviews r USING (listing_id);

CREATE OR REPLACE VIEW listings_current AS
SELECT * FROM listings WHERE is_current;

-- Each listing's most recent photo set.
CREATE OR REPLACE VIEW listing_photos_current AS
SELECT
    listing_id,
    photo_urls,
    len(photo_urls)::INTEGER AS photo_count,
    valid_from AS photos_valid_from
FROM listing_photos
QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY valid_from DESC) = 1;

-- Current calendar rows, minus the future nights of retired listings.
--
-- A retired listing's calendar is no longer fetched, so its future nights
-- stay is_current for up to twelve months. Nights up to its last_seen_date
-- are real observations and are kept.
CREATE OR REPLACE VIEW calendar_current AS
SELECT c.*
FROM calendar_status c
JOIN listing_activity a USING (listing_id)
WHERE c.is_current
  AND (a.is_current OR c.night_date <= a.last_seen_date);

-- Per host: first and last seen, last card read, and whether current, on
-- the same rule as \`listing_activity\`. \`hosting_started_on\` is the earliest
-- start date any reading implies, and \`hosting_start_spread_days\` how far
-- the readings disagree. Month rounding alone keeps the spread under about a
-- month; the \`host_start_date_stable\` check warns beyond that.
CREATE OR REPLACE VIEW host_activity AS
SELECT
    host_id,
    min(scrape_date) AS first_seen_date,
    max(scrape_date) AS last_seen_date,
    max(scrape_date) FILTER (WHERE profile_read_ok) AS profile_seen_date,
    min({hosting_start}) FILTER (WHERE profile_read_ok) AS hosting_started_on,
    date_diff(
        'day',
        min({hosting_start}) FILTER (WHERE profile_read_ok),
        max({hosting_start}) FILTER (WHERE profile_read_ok)
    )::INTEGER AS hosting_start_spread_days,
    -- Whole years of \`timeAsHost\` at the latest reading.
    arg_max(time_as_host_years, scrape_date)
        FILTER (WHERE profile_read_ok AND time_as_host_years IS NOT NULL) AS years_hosting,
    max(scrape_date) >= (
        SELECT scrape_date FROM latest_scrape_date
    ) - INTERVAL {grace} DAY AS is_current
FROM host_observations
GROUP BY host_id;

-- Gaps-and-islands over (name, about), as in \`listing_versions\`. A day
-- whose card was not read contributes a NULL profile, which the carry-forward
-- skips, so a failed read neither blanks the host nor opens a version.
-- \`timeAsHost\` grows monthly, so it is summarized in \`host_activity\`
-- rather than versioned.
CREATE OR REPLACE VIEW host_versions AS
WITH observed AS (
    SELECT
        host_id,
        scrape_date,
        CASE WHEN profile_read_ok THEN {'name': name, 'about': about} END AS profile
    FROM host_observations
),
carried AS (
    SELECT
        host_id,
        scrape_date,
        last_value(profile IGNORE NULLS) OVER (
            PARTITION BY host_id ORDER BY scrape_date
        ) AS profile
    FROM observed
),
-- Wrapped so "no card read yet" (a NULL profile) differs from lag()'s NULL
-- on the first row.
marked AS (
    SELECT *,
        CASE WHEN {'p': profile} IS DISTINCT FROM lag({'p': profile}) OVER w
             THEN 1 ELSE 0 END AS opens_version
    FROM carried
    WINDOW w AS (PARTITION BY host_id ORDER BY scrape_date)
),
numbered AS (
    SELECT *,
        sum(opens_version) OVER (PARTITION BY host_id ORDER BY scrape_date) AS version_no
    FROM marked
),
aggregated AS (
    SELECT
        host_id,
        version_no,
        min(scrape_date) AS valid_from,
        max(scrape_date) AS version_last_seen_date,
        any_value(profile) AS profile
    FROM numbered
    GROUP BY host_id, version_no
)
SELECT
    host_id,
    version_no,
    valid_from,
    version_last_seen_date,
    profile.name AS name,
    profile.about AS about,
    lead(valid_from) OVER (PARTITION BY host_id ORDER BY version_no) AS valid_to
FROM aggregated;

-- The host dimension. Join to \`listings\` on host_id; filter \`is_current\`
-- for one row per host.
CREATE OR REPLACE VIEW hosts AS
SELECT
    v.host_id,
    v.name,
    v.about,
    a.hosting_started_on,
    year(a.hosting_started_on)::INTEGER AS hosting_started_year,
    a.years_hosting,
    a.hosting_start_spread_days,
    a.profile_seen_date,
    a.first_seen_date,
    a.last_seen_date,
    v.version_no,
    v.version_last_seen_date,
    v.valid_from,
    v.valid_to,
    v.valid_to IS NULL AND a.is_current AS is_current
FROM host_versions v
JOIN host_activity a USING (host_id);

-- Listings per host per completed run date. Counts only: no threshold or
-- owner/operator label is stored; that line is drawn downstream.
--
-- listings_live       listings held by the host that were live on
--                     scrape_date: the \`listing_activity.is_current\` rule
--                     evaluated as of that date.
-- listings_ever_seen  distinct listings observed under the host on or before
--                     scrape_date, live or not.
--
-- A row exists for every run date from the host's first observation on, so
-- a portfolio winding down reads as zeros rather than missing rows. A
-- listing's host is carried forward past failed page fetches as in
-- \`listing_versions\`, so the latest date agrees with
-- \`listings_current.host_id\`. A listing whose page was never read has no
-- known host and is counted under nobody.
--
-- Only listings in the Anchorage search area are counted, not a host's
-- listings elsewhere.
CREATE OR REPLACE VIEW host_portfolios AS
WITH held AS (
    SELECT
        listing_id,
        scrape_date,
        -- A struct, so "read the page, no host" is not skipped over the way
        -- "page not read" is.
        last_value(
            CASE WHEN page_fetch_ok THEN {'host_id': host_id} END IGNORE NULLS
        ) OVER (PARTITION BY listing_id ORDER BY scrape_date).host_id AS host_id
    FROM listing_observations
),
-- Completed runs, by \`latest_scrape_date\`'s definition.
run_dates AS (
    SELECT scrape_date FROM listing_observations
    UNION
    SELECT scrape_date FROM scrape_runs WHERE listings_seen IS NOT NULL
),
-- Each listing live on each run date, held by whoever its latest observation
-- on or before that date names.
live AS (
    SELECT d.scrape_date, h.listing_id, h.host_id
    FROM run_dates d
    JOIN held h
      ON h.scrape_date BETWEEN d.scrape_date - INTERVAL {grace} DAY AND d.scrape_date
    QUALIFY row_number() OVER (
        PARTITION BY d.scrape_date, h.listing_id ORDER BY h.scrape_date DESC
    ) = 1
),
live_counts AS (
    SELECT host_id, scrape_date, count(*) AS listings_live
    FROM live
    WHERE host_id IS NOT NULL
    GROUP BY host_id, scrape_date
),
first_held AS (
    SELECT host_id, listing_id, min(scrape_date) AS scrape_date
    FROM held
    WHERE host_id IS NOT NULL
    GROUP BY host_id, listing_id
),
newly_seen AS (
    SELECT host_id, scrape_date, count(*) AS listings_new
    FROM first_held
    GROUP BY host_id, scrape_date
),
panel AS (
    SELECT f.host_id, d.scrape_date
    FROM (SELECT host_id, min(scrape_date) AS since FROM first_held GROUP BY host_id) f
    JOIN run_dates d ON d.scrape_date >= f.since
)
SELECT
    p.host_id,
    p.scrape_date,
    coalesce(l.listings_live, 0)::INTEGER AS listings_live,
    sum(coalesce(n.listings_new, 0)) OVER (
        PARTITION BY p.host_id ORDER BY p.scrape_date
    )::INTEGER AS listings_ever_seen
FROM panel p
LEFT JOIN live_counts l USING (host_id, scrape_date)
LEFT JOIN newly_seen n USING (host_id, scrape_date);

-- \`listings_current\` plus the owning host's profile and portfolio as of the
-- latest run, so "is this Girdwood room part of a large portfolio?" needs no
-- join. The host columns are NULL when the host is unknown.
CREATE OR REPLACE VIEW listings_current_with_host AS
SELECT
    l.*,
    h.name AS host_name,
    h.years_hosting AS host_years_hosting,
    h.hosting_started_on AS host_hosting_started_on,
    p.listings_live AS host_listings_live,
    p.listings_ever_seen AS host_listings_ever_seen
FROM listings_current l
LEFT JOIN hosts h
  ON h.host_id = l.host_id AND h.valid_to IS NULL
LEFT JOIN host_portfolios p
  ON p.host_id = l.host_id
 AND p.scrape_date = (SELECT scrape_date FROM latest_scrape_date);

-- Stored in the file, so readers of the published .duckdb see the scope.
COMMENT ON VIEW host_portfolios IS 'Listings per Airbnb host account per scrape date. Counts only listings in the Anchorage search area, not a host''s listings elsewhere. No owner/operator threshold is stored.';
COMMENT ON COLUMN host_portfolios.listings_live IS 'Listings held by this host that were live on scrape_date (seen within the retirement grace window ending that day).';
COMMENT ON COLUMN host_portfolios.listings_ever_seen IS 'Distinct listings observed under this host on or before scrape_date, live or retired.';
COMMENT ON VIEW listings_current_with_host IS 'listings_current plus the host''s name, tenure, and host_portfolios counts as of the latest run. NULL when the host is unknown. Portfolio counts cover only the Anchorage search area.';
`;

function viewsSql(): string {
  return VIEWS_SQL.replaceAll('{grace}', String(config.RETIREMENT_GRACE_DAYS))
    .replaceAll('{hosting_start}', IMPLIED_HOSTING_START_SQL)
    .replace('{page_attrs}', PAGE_ATTRS_SQL)
    .replace('{version_key}', VERSION_KEY_SQL);
}

/** Raised for a database whose schema this code cannot read. */
export class LegacySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacySchemaError';
  }
}

const NO_MIGRATION =
  "There is no migration: see CONTRIBUTING.md, 'When the published database has an incompatible schema'.";

/**
 * Throw on an incompatible database.
 *
 * A `listings` table stores version intervals rather than daily
 * observations. It has no migration because expanding intervals into daily
 * rows would invent observations for days that may have had no run.
 */
async function rejectLegacySchema(db: Database): Promise<void> {
  const legacyTable = await db.count(
    "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'listings'",
  );
  if (legacyTable) {
    throw new LegacySchemaError(
      `this database has \`listings\` as a table rather than a view. ${NO_MIGRATION}`,
    );
  }
  const columns = await db.rows<{ column_name: string }>(
    "SELECT column_name FROM duckdb_columns() WHERE table_name = 'listing_observations'",
  );
  if (columns.length === 0) return;
  for (const required of ['page_fetch_ok', 'host_id', 'quote_total']) {
    if (!columns.some((row) => row.column_name === required)) {
      throw new LegacySchemaError(
        `\`listing_observations\` has no \`${required}\` column. ${NO_MIGRATION}`,
      );
    }
  }
}

/**
 * Open (or create) the database, rejecting an incompatible file, and refresh
 * the views. Creates the Municipal registry's tables and views too (see
 * `registryStore.ts`), so both the daily and registry runs see one schema.
 */
export async function connect(path: string): Promise<Database> {
  const db = await Database.open(path);
  await rejectLegacySchema(db);
  await db.run(SCHEMA_SQL);
  await db.run(REGISTRY_SCHEMA_SQL);
  await db.run(viewsSql());
  // After the listing views, which `registrations` reads.
  await db.run(REGISTRY_VIEWS_SQL);
  return db;
}

// --------------------------------------------------------------------------
// observations

export interface ObservationStats {
  seen: number;
  new: number;
  changed: number;
  retired: number;
}

/** Column order and types for the daily insert. */
const OBSERVATION_COLUMNS = [
  ['listing_id', BIGINT],
  ['scrape_date', DATE],
  ['name', VARCHAR],
  ['property_title', VARCHAR],
  ['location_lat', DOUBLE],
  ['location_lng', DOUBLE],
  ['url', VARCHAR],
  ['badges', LIST(VARCHAR)],
  ['rating_value', DOUBLE],
  ['review_count', INTEGER],
  ['price_hint_per_night', DOUBLE],
  ['price_qualifier', VARCHAR],
  ['page_fetch_ok', BOOLEAN],
  ['location_is_exact', BOOLEAN],
  ['location_exact_address', VARCHAR],
  ['location_subtitle', VARCHAR],
  ['location_verified', BOOLEAN],
  ['str_registration_id', VARCHAR],
  ['host_id', BIGINT],
  ['room_type', VARCHAR],
  ['guest_capacity', INTEGER],
  ['beds', INTEGER],
  ['bedrooms', VARCHAR],
  ['bathrooms', VARCHAR],
  ['quote_check_in', DATE],
  ['quote_nights', INTEGER],
  ['quote_total', DOUBLE],
  ['quote_label', VARCHAR],
  ['quote_breakdown', LIST(VARCHAR)],
] as const satisfies ReadonlyArray<readonly [string, DuckDBType]>;

const OBSERVATION_TYPES = OBSERVATION_COLUMNS.map(([, type]) => type);

/**
 * Write one day's listing observations and report what changed.
 *
 * Idempotent per scrape date: re-running a day replaces its rows.
 *
 * A listing with no successful entry in `pages` records `page_fetch_ok =
 * false` and NULL page columns. One with no successful entry in `quotes`
 * records NULL quote columns.
 *
 * `changed` and `retired` are read from the views so the run log matches
 * what later queries see.
 */
export async function recordObservations(
  db: Database,
  scrapeDate: IsoDate,
  parsed: readonly ParsedListing[],
  pages: readonly ListingPage[] = [],
  quotes: readonly PriceQuote[] = [],
): Promise<ObservationStats> {
  const byRoom = new Map<bigint, ListingPage>();
  for (const page of pages) {
    if (!page.error) byRoom.set(BigInt(page.roomId), page);
  }
  const quoteByRoom = new Map<bigint, PriceQuote>();
  for (const quote of quotes) {
    if (!quote.error) quoteByRoom.set(BigInt(quote.roomId), quote);
  }

  await db.run('DELETE FROM listing_observations WHERE scrape_date = CAST(? AS DATE)', [scrapeDate]);
  // After the delete, so a re-run doesn't count its own earlier rows as
  // history. `BIGINT` reads back as a decimal string, which `BigInt` parses
  // exactly.
  const previouslySeen = new Set(
    (
      await db.rows<{ listing_id: string }>(
        'SELECT DISTINCT listing_id FROM listing_observations',
      )
    ).map((row) => BigInt(row.listing_id)),
  );

  if (parsed.length > 0) {
    const appender = await db.appender('listing_observations');
    const day = dateValue(epochDays(scrapeDate));
    for (const listing of parsed) {
      const page = byRoom.get(listing.listingId);
      const quote = quoteByRoom.get(listing.listingId);
      appendRow(appender, OBSERVATION_TYPES, [
        listing.listingId,
        day,
        listing.name,
        listing.propertyTitle,
        listing.lat,
        listing.lng,
        listing.url,
        listValue(listing.badges),
        listing.ratingValue,
        listing.reviewCount,
        listing.priceHintPerNight,
        listing.priceQualifier,
        page !== undefined,
        page?.locationIsExact ?? null,
        page?.locationExactAddress ?? null,
        page?.locationSubtitle ?? null,
        page?.locationVerified ?? null,
        page?.strRegistrationId ?? null,
        page?.hostId == null ? null : BigInt(page.hostId),
        page?.roomType ?? null,
        page?.guestCapacity ?? null,
        page?.beds ?? null,
        page?.bedrooms ?? null,
        page?.bathrooms ?? null,
        quote ? dateValue(epochDays(quote.checkIn)) : null,
        quote?.nights ?? null,
        quote?.total ?? null,
        quote?.label ?? null,
        quote ? listValue(quote.breakdown) : null,
      ] satisfies DuckDBValue[]);
    }
    appender.flushSync();
    appender.closeSync();
  }

  await recordPhotos(
    db,
    scrapeDate,
    parsed.flatMap((listing) => {
      const urls = byRoom.get(listing.listingId)?.photoUrls;
      return urls ? [{ listingId: listing.listingId, urls }] : [];
    }),
  );

  return {
    seen: parsed.length,
    new: parsed.filter((listing) => !previouslySeen.has(listing.listingId)).length,
    changed: await db.count(
      'SELECT count(*) FROM listing_versions WHERE valid_from = CAST(? AS DATE)',
      [scrapeDate],
    ),
    retired: await countNewlyRetired(db, scrapeDate, config.RETIREMENT_GRACE_DAYS),
  };
}

/**
 * Write each listing's photo set if it differs from the listing's previous
 * one, including a change of order. A page read without photos writes
 * nothing, so the previous set stays current.
 *
 * Idempotent per scrape date: re-running a day replaces its rows.
 */
async function recordPhotos(
  db: Database,
  scrapeDate: IsoDate,
  sets: ReadonlyArray<{ listingId: bigint; urls: readonly string[] }>,
): Promise<void> {
  await db.run('DELETE FROM listing_photos WHERE valid_from = CAST(? AS DATE)', [scrapeDate]);
  if (sets.length === 0) return;

  await db.run(
    'CREATE OR REPLACE TEMP TABLE stg_photos (listing_id BIGINT, photo_urls VARCHAR[])',
  );
  const staging = await db.appender('stg_photos');
  for (const set of sets) {
    appendRow(staging, PHOTO_STAGING_TYPES, [set.listingId, listValue([...set.urls])]);
  }
  staging.flushSync();
  staging.closeSync();

  await db.run(
    `
    INSERT INTO listing_photos (listing_id, valid_from, photo_urls)
    SELECT s.listing_id, CAST(? AS DATE), s.photo_urls
    FROM stg_photos s
    LEFT JOIN (
        SELECT listing_id, photo_urls FROM listing_photos
        WHERE valid_from < CAST(? AS DATE)
        QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY valid_from DESC) = 1
    ) prev USING (listing_id)
    WHERE prev.photo_urls IS DISTINCT FROM s.photo_urls
    `,
    [scrapeDate, scrapeDate],
  );
  await db.run('DROP TABLE stg_photos');
}

const PHOTO_STAGING_TYPES = [BIGINT, LIST(VARCHAR)] satisfies DuckDBType[];

/**
 * How many listings became retired on this date: those last observed
 * exactly `grace + 1` days ago.
 *
 * Assumes daily runs. A gap shifts which run reports the retirement but not
 * whether the listing is current.
 */
export async function countNewlyRetired(
  db: Database,
  scrapeDate: IsoDate,
  graceDays: number,
): Promise<number> {
  return db.count(
    'SELECT count(*) FROM (SELECT listing_id FROM listing_observations ' +
      'GROUP BY listing_id HAVING max(scrape_date) = CAST(? AS DATE))',
    [addDays(scrapeDate, -(graceDays + 1))],
  );
}

// --------------------------------------------------------------------------
// listing-page pass statistics

/**
 * One run's listing-page pass, summarized for logging and the quality
 * checks. Which extraction layer produced a value is not stored in the
 * database.
 */
export interface PageFetchStats {
  attempted: number;
  failed: number;
  exactLocated: number;
  registered: number;
  withHostId: number;
  withRoomType: number;
  withGuestCapacity: number;
  withBeds: number;
  withBedrooms: number;
  withBathrooms: number;
  withPhotos: number;
  /**
   * How many fetched pages yielded the exact-location flag, and how many
   * each extraction layer contributed to. The checks use these to detect a
   * layer that stopped working.
   */
  withExactFlag: number;
  layerUsed: Record<Layer, number>;
}

export function emptyPageStats(): PageFetchStats {
  return {
    attempted: 0,
    failed: 0,
    exactLocated: 0,
    registered: 0,
    withHostId: 0,
    withRoomType: 0,
    withGuestCapacity: 0,
    withBeds: 0,
    withBedrooms: 0,
    withBathrooms: 0,
    withPhotos: 0,
    withExactFlag: 0,
    layerUsed: { 'json-ld': 0, state: 0, 'raw-html': 0 },
  };
}

export function summarizePages(pages: readonly ListingPage[]): PageFetchStats {
  const ok = pages.filter((page) => !page.error);
  const layerUsed = { 'json-ld': 0, state: 0, 'raw-html': 0 } satisfies Record<Layer, number>;
  for (const layer of LAYERS) {
    layerUsed[layer] = ok.filter((page) =>
      (page.locationSource ?? '').split('+').includes(layer),
    ).length;
  }
  return {
    attempted: pages.length,
    failed: pages.length - ok.length,
    exactLocated: ok.filter((page) => page.locationIsExact === true).length,
    registered: ok.filter((page) => page.strRegistrationId !== null).length,
    withHostId: ok.filter((page) => page.hostId !== null).length,
    withRoomType: ok.filter((page) => page.roomType !== null).length,
    withGuestCapacity: ok.filter((page) => page.guestCapacity !== null).length,
    withBeds: ok.filter((page) => page.beds !== null).length,
    withBedrooms: ok.filter((page) => page.bedrooms !== null).length,
    withBathrooms: ok.filter((page) => page.bathrooms !== null).length,
    withPhotos: ok.filter((page) => page.photoUrls !== null).length,
    withExactFlag: ok.filter((page) => page.locationIsExact !== null).length,
    layerUsed,
  };
}

// --------------------------------------------------------------------------
// price-quote pass statistics

export interface QuoteStats {
  /** Listings with a bookable stay to quote. */
  attempted: number;
  failed: number;
  /** Quotes read without error that carry a price. */
  priced: number;
}

export function summarizeQuotes(quotes: readonly PriceQuote[]): QuoteStats {
  const ok = quotes.filter((quote) => !quote.error);
  return {
    attempted: quotes.length,
    failed: quotes.length - ok.length,
    priced: ok.filter((quote) => quote.total !== null).length,
  };
}

// --------------------------------------------------------------------------
// hosts

export interface HostProfileStats {
  /** Distinct hosts owning a listing observed today. */
  attempted: number;
  /** Of those, how many had no card read today. */
  failed: number;
  new: number;
  changed: number;
}

const HOST_OBSERVATION_TYPES = [
  BIGINT,
  DATE,
  BOOLEAN,
  VARCHAR,
  VARCHAR,
  INTEGER,
  INTEGER,
] satisfies DuckDBType[];

/**
 * Write one day's host observations: a row for every host owning a listing
 * observed today, whether or not their card was read.
 *
 * Runs after `recordObservations` for the same date, in the same transaction:
 * today's owners are read back from `listings`, so a listing whose page failed
 * today still names its owner through the carried-forward `host_id`.
 *
 * `cards` is `collectHostCards`' output. Idempotent per scrape date.
 */
export async function recordHostObservations(
  db: Database,
  scrapeDate: IsoDate,
  cards: ReadonlyMap<string, HostCard>,
): Promise<HostProfileStats> {
  await db.run('DELETE FROM host_observations WHERE scrape_date = CAST(? AS DATE)', [scrapeDate]);
  const previouslySeen = new Set(
    (
      await db.rows<{ host_id: string }>('SELECT DISTINCT host_id FROM host_observations')
    ).map((row) => row.host_id),
  );
  const owners = (
    await db.rows<{ host_id: string }>(
      'SELECT DISTINCT host_id FROM listings ' +
        'WHERE valid_to IS NULL AND last_seen_date = CAST(? AS DATE) AND host_id IS NOT NULL',
      [scrapeDate],
    )
  ).map((row) => row.host_id);
  const hostIds = [...new Set([...owners, ...cards.keys()])];

  if (hostIds.length > 0) {
    const appender = await db.appender('host_observations');
    const day = dateValue(epochDays(scrapeDate));
    for (const hostId of hostIds) {
      const card = cards.get(hostId);
      appendRow(appender, HOST_OBSERVATION_TYPES, [
        BigInt(hostId),
        day,
        card !== undefined,
        card?.name ?? null,
        card?.about ?? null,
        card?.timeAsHostYears ?? null,
        card?.timeAsHostMonths ?? null,
      ]);
    }
    appender.flushSync();
    appender.closeSync();
  }

  return {
    attempted: hostIds.length,
    failed: hostIds.filter((hostId) => !cards.has(hostId)).length,
    new: hostIds.filter((hostId) => !previouslySeen.has(hostId)).length,
    changed: await db.count(
      'SELECT count(*) FROM host_versions WHERE valid_from = CAST(? AS DATE)',
      [scrapeDate],
    ),
  };
}

// --------------------------------------------------------------------------
// calendar

export interface CalendarMergeStats {
  attempted: number;
  failed: number;
  nightsChanged: number;
}

const STAGING_TYPES = [BIGINT, DATE, BOOLEAN, INTEGER] satisfies DuckDBType[];

const CALENDAR_INSERT_TYPES = [
  BIGINT,
  DATE,
  BOOLEAN,
  INTEGER,
  VARCHAR,
  DATE,
  DATE,
  BOOLEAN,
] satisfies DuckDBType[];

interface ChangedNight {
  listing_id: string;
  night_date: string;
  available: boolean;
  min_nights: number | null;
  status_hash: string;
}

/** SCD2-merge one run's calendar. See the module docstring. */
export async function mergeCalendar(
  db: Database,
  scrapeDate: IsoDate,
  results: readonly CalendarResult[],
): Promise<CalendarMergeStats> {
  const stats: CalendarMergeStats = {
    attempted: results.length,
    failed: results.filter((result) => result.error).length,
    nightsChanged: 0,
  };
  const usable = results.filter((result) => !result.error);
  if (!usable.some((result) => result.nights.length > 0)) return stats;

  await db.run(
    'CREATE OR REPLACE TEMP TABLE stg_calendar ' +
      '(listing_id BIGINT, night_date DATE, available BOOLEAN, min_nights INTEGER)',
  );
  const staging = await db.appender('stg_calendar');
  for (const result of usable) {
    const listingId = BigInt(result.roomId);
    for (const night of result.nights) {
      appendRow(staging, STAGING_TYPES, [
        listingId,
        dateValue(epochDays(night.nightDate)),
        night.available,
        night.minNights,
      ]);
    }
  }
  staging.flushSync();
  staging.closeSync();

  await db.run('ALTER TABLE stg_calendar ADD COLUMN status_hash VARCHAR');
  // The trailing '|' is part of the hash format of every stored row. Changing
  // the format would re-version every current night on the next run.
  await db.run(
    "UPDATE stg_calendar SET status_hash = md5(available::VARCHAR || '|' || " +
      "coalesce(min_nights::VARCHAR,'') || '|')",
  );

  const changed = await db.rows<ChangedNight>(
    'SELECT s.listing_id, s.night_date, s.available, s.min_nights, s.status_hash ' +
      'FROM stg_calendar s ' +
      'LEFT JOIN calendar_status c ' +
      '  ON c.listing_id = s.listing_id AND c.night_date = s.night_date AND c.is_current ' +
      'WHERE c.listing_id IS NULL OR c.status_hash != s.status_hash',
  );
  stats.nightsChanged = changed.length;
  if (changed.length === 0) return stats;

  await db.run(
    `
    UPDATE calendar_status SET valid_to = CAST(? AS DATE), is_current = false
    WHERE is_current AND (listing_id, night_date) IN (
        SELECT s.listing_id, s.night_date FROM stg_calendar s
        JOIN calendar_status c
          ON c.listing_id = s.listing_id AND c.night_date = s.night_date AND c.is_current
        WHERE c.status_hash != s.status_hash
    )
    `,
    [scrapeDate],
  );

  const appender = await db.appender('calendar_status');
  const validFrom = dateValue(epochDays(scrapeDate));
  for (const night of changed) {
    appendRow(appender, CALENDAR_INSERT_TYPES, [
      BigInt(night.listing_id),
      dateValue(epochDays(night.night_date)),
      night.available,
      night.min_nights,
      night.status_hash,
      validFrom,
      null,
      true,
    ]);
  }
  appender.flushSync();
  appender.closeSync();
  return stats;
}

// --------------------------------------------------------------------------
// first reviews

/**
 * This run's listings whose earliest review has not been resolved, in
 * ascending `listing_id` order (older listings first). `fetchFirstReviews`
 * caps how many are attempted.
 */
export async function pendingFirstReviews(
  db: Database,
  listings: readonly ParsedListing[],
): Promise<FirstReviewCandidate[]> {
  const resolved = new Set(
    (
      await db.rows<{ listing_id: string }>('SELECT listing_id FROM listing_first_reviews')
    ).map((row) => BigInt(row.listing_id)),
  );
  return listings
    .filter((listing) => !resolved.has(listing.listingId))
    .sort((a, b) => (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0))
    .map((listing) => ({
      roomId: String(listing.listingId),
      reviewCountHint: listing.reviewCount,
    }));
}

export interface FirstReviewStats {
  attempted: number;
  failed: number;
  /** Resolved listings that have at least one review. */
  withReviews: number;
}

export function summarizeFirstReviews(results: readonly FirstReviewResult[]): FirstReviewStats {
  const ok = results.filter((result) => !result.error);
  return {
    attempted: results.length,
    failed: results.length - ok.length,
    withReviews: ok.filter((result) => result.firstReviewDate !== null).length,
  };
}

const FIRST_REVIEW_TYPES = [BIGINT, DATE, DATE] satisfies DuckDBType[];

/**
 * Store each successful resolution. Failed results write nothing, so the
 * listing stays pending. Throws on a listing that is already resolved, which
 * `pendingFirstReviews` never returns.
 */
export async function recordFirstReviews(
  db: Database,
  scrapeDate: IsoDate,
  results: readonly FirstReviewResult[],
): Promise<void> {
  const ok = results.filter((result) => !result.error);
  if (ok.length === 0) return;
  const appender = await db.appender('listing_first_reviews');
  const resolvedDate = dateValue(epochDays(scrapeDate));
  for (const result of ok) {
    appendRow(appender, FIRST_REVIEW_TYPES, [
      BigInt(result.roomId),
      result.firstReviewDate === null ? null : dateValue(epochDays(result.firstReviewDate)),
      resolvedDate,
    ]);
  }
  appender.flushSync();
  appender.closeSync();
}

// --------------------------------------------------------------------------
// run log

export interface RunRow {
  scrapeDate: IsoDate;
  runStartedAt: string;
  runFinishedAt: string | null;
  listingsSeen: number | null;
  listingsNew: number | null;
  listingsChanged: number | null;
  listingsRetired: number | null;
  calendarFetchAttempted: number | null;
  calendarFetchFailed: number | null;
  calendarNightsChanged: number | null;
  pageFetchAttempted: number | null;
  pageFetchFailed: number | null;
  firstReviewFetchAttempted: number | null;
  firstReviewFetchFailed: number | null;
  quoteFetchAttempted: number | null;
  quoteFetchFailed: number | null;
  hostProfileAttempted: number | null;
  hostProfileFailed: number | null;
  errorSummary: string | null;
}

export async function logRun(db: Database, run: RunRow): Promise<void> {
  await db.run(
    'INSERT INTO scrape_runs ' +
      '(scrape_date, run_started_at, run_finished_at, listings_seen, listings_new, ' +
      ' listings_changed, listings_retired, calendar_fetch_attempted, calendar_fetch_failed, ' +
      ' calendar_nights_changed, page_fetch_attempted, page_fetch_failed, ' +
      ' first_review_fetch_attempted, first_review_fetch_failed, ' +
      ' quote_fetch_attempted, quote_fetch_failed, ' +
      ' host_profile_attempted, host_profile_failed, error_summary) ' +
      'VALUES (CAST(? AS DATE), CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), ' +
      '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      run.scrapeDate,
      run.runStartedAt,
      run.runFinishedAt,
      run.listingsSeen,
      run.listingsNew,
      run.listingsChanged,
      run.listingsRetired,
      run.calendarFetchAttempted,
      run.calendarFetchFailed,
      run.calendarNightsChanged,
      run.pageFetchAttempted,
      run.pageFetchFailed,
      run.firstReviewFetchAttempted,
      run.firstReviewFetchFailed,
      run.quoteFetchAttempted,
      run.quoteFetchFailed,
      run.hostProfileAttempted,
      run.hostProfileFailed,
      run.errorSummary,
    ],
    // Date and timestamp parameters are bound as strings and cast in SQL,
    // which accepts ISO dates, naive timestamps and NULL alike.
    [
      VARCHAR,
      VARCHAR,
      VARCHAR,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      VARCHAR,
    ],
  );
}
