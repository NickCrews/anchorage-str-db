/**
 * DuckDB schema and merge logic.
 *
 * Two grains of observation, one run log, and a set of views that
 * reconstruct the slowly-changing dimensions on top of them.
 *
 * - `listing_observations` — append-only, one row per (listing, day) it was
 *   seen in search results. Everything we learned about the listing that
 *   day: the search fields, the listing-page fields, and the volatile stuff
 *   (rating, review count, nightly price hint). This is the source of truth;
 *   nothing else about a listing is stored.
 * - `calendar_status` — SCD2 on (listing_id, night_date): whether that night
 *   was available, as observed. Once a night_date scrolls out of Airbnb's
 *   ~12-month forward calendar window, we simply stop observing it, so its
 *   last known value freezes in place — which is exactly the realized
 *   booked/available call for a night once it's in the past. No special
 *   "close out old nights" logic is needed for that; see README for the
 *   caveat that "not available" conflates real bookings with host blocks.
 * - `scrape_runs` — one row per run, for freshness and failure tracking.
 *
 * Why `listings` is a view and `calendar_status` is a table
 * --------------------------------------------------------
 * A snapshot per day costs about 400 times more for the calendar than for
 * listings:
 *
 * - calendar: ~2600 listings x ~365 forward nights = ~950k rows/day,
 *   ~350M/year. Storing a row per night per day is genuinely infeasible, so
 *   it earns its merge logic.
 * - listings: ~2600 rows/day, ~950k/year — and the most compressible data
 *   imaginable, the same twenty columns repeating verbatim. Change-only
 *   merging would buy nothing and cost a mutable, hand-maintained history.
 *
 * So `listings` is derived: `listing_versions` runs gaps-and-islands over
 * the daily rows to rebuild `valid_from`/`valid_to`, and `listing_activity`
 * aggregates first/last/page-seen dates.
 *
 * Deriving gives three properties a stored table would not:
 *
 * 1. `first_seen_date` and `last_seen_date` cannot disagree with the
 *    observations, because they *are* the observations — including for a
 *    listing that retires and later comes back, which is the case a
 *    hand-maintained column gets wrong.
 * 2. History is recomputable. Runs mutate an append-only table, so a bug in
 *    the version logic is fixed by editing a view, not by backfilling a
 *    database that is itself the only copy (see CONTRIBUTING: the published
 *    .duckdb file is downloaded, mutated, and re-uploaded each run).
 * 3. Freshness is answerable per field — `max(scrape_date) FILTER (WHERE
 *    <field> IS NOT NULL)` — rather than only for the questions someone
 *    thought to add a `*_seen_date` column for.
 *
 * The listing-page fields (`location_is_exact`, `str_registration_id`, ...)
 * sit on the same row as the search fields rather than in a table of their
 * own, even though they come from a second endpoint that fails
 * independently. They describe the listing, not an event, and
 * `location_is_exact` in particular is a modifier on the
 * `location_lat`/`location_lng` columns sitting right next to it —
 * splitting them would mean no query could read a coordinate without a
 * join, which is how you end up with analyses that quietly treat jittered
 * pins as real addresses.
 *
 * `page_fetch_ok` is what makes that safe to store per-day: a day we
 * couldn't read the page records NULLs and `false`, and the *view* carries
 * the last successful read forward. Carrying forward in the view rather than
 * on write keeps the raw row honest about what we actually saw.
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

import type { CalendarResult } from './calendars.ts';
import * as config from './config.ts';
import { addDays, epochDays, type IsoDate } from './dates.ts';
import { appendRow, Database } from './db.ts';
import type { Layer, ListingPage } from './listingPage.ts';
import { LAYERS } from './listingPage.ts';
import type { ParsedListing } from './parse.ts';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS listing_observations (
    listing_id BIGINT NOT NULL,
    scrape_date DATE NOT NULL,

    -- From the search response; present for every observed listing.
    name VARCHAR,
    property_title VARCHAR,
    bedrooms INTEGER,
    beds INTEGER,
    bathrooms DOUBLE,
    guest_capacity INTEGER,
    location_lat DOUBLE,
    location_lng DOUBLE,
    url VARCHAR,
    badges VARCHAR[],

    -- Volatile: these move most days, which is why they are deliberately
    -- *not* part of the version key. A new review is not a new listing.
    rating_value DOUBLE,
    review_count INTEGER,
    price_hint_per_night DOUBLE,
    price_qualifier VARCHAR,

    -- From the listing's own page, a separate request that fails
    -- independently. \`page_fetch_ok\` distinguishes "we read the page and
    -- this host publishes no STR number" from "we never got to look" --
    -- without it, both are five NULLs and carry-forward can't tell them
    -- apart. Everything below it is NULL whenever it is false.
    page_fetch_ok BOOLEAN NOT NULL,
    location_is_exact BOOLEAN,
    location_exact_address VARCHAR,
    location_subtitle VARCHAR,
    location_verified BOOLEAN,
    str_registration_id VARCHAR,

    PRIMARY KEY (listing_id, scrape_date)
);

CREATE TABLE IF NOT EXISTS calendar_status (
    listing_id BIGINT NOT NULL,
    night_date DATE NOT NULL,
    available BOOLEAN NOT NULL,
    min_nights INTEGER,
    price_amount DOUBLE,
    status_hash VARCHAR NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    is_current BOOLEAN NOT NULL
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
`;

/**
 * Attributes whose change opens a new listing version. Volatile columns
 * (rating, review count, price hint) are excluded on purpose — they belong
 * to the day, not to the listing — and so is `url`, which is a function of
 * `listing_id`. Coordinates are rounded to 6dp so float noise in Airbnb's
 * response doesn't read as the listing having moved.
 */
const VERSION_KEY_SQL = `{
    'name': name,
    'property_title': property_title,
    'bedrooms': bedrooms,
    'beds': beds,
    'bathrooms': bathrooms,
    'guest_capacity': guest_capacity,
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
    'str_registration_id': str_registration_id
}`;

/**
 * `{grace}` is filled from `config.RETIREMENT_GRACE_DAYS`. The views are
 * CREATE OR REPLACE'd on every `connect()`, so changing that constant takes
 * effect on the next run rather than needing a rebuild.
 */
export const VIEWS_SQL = `
-- The date retirement is measured back from: the most recent run that
-- actually completed its write phase.
--
-- Not simply \`max(scrape_date)\` from the observations, because that stops
-- advancing exactly when it matters -- a run where every listing had
-- vanished would write no rows, freeze the clock, and leave every dead
-- listing reading as current forever. Not \`max(scrape_date)\` from
-- \`scrape_runs\` either, because a *failed* run logs a row there with all
-- counts NULL, and a run that scraped nothing must not retire anything.
-- \`listings_seen IS NOT NULL\` is the marker for a run that got as far as
-- writing, so the two sources together cover both holes.
CREATE OR REPLACE VIEW latest_scrape_date AS
SELECT max(scrape_date) AS scrape_date FROM (
    SELECT max(scrape_date) AS scrape_date FROM listing_observations
    UNION ALL
    SELECT max(scrape_date) AS scrape_date FROM scrape_runs
    WHERE listings_seen IS NOT NULL
);

-- Per-listing summary over its whole observed history: when we first and
-- last saw it, when we last successfully read its page, and whether it is
-- still live.
--
-- "Still live" is the retirement rule, and it lives here rather than in an
-- UPDATE pass because it is a question about the observations, not a fact
-- to be stored: a listing is current if we have seen it within
-- RETIREMENT_GRACE_DAYS of the most recent scrape. The grace exists because
-- Airbnb's map search paginates unreliably, and a listing blinking out for
-- a day should not read as "this STR closed."
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

-- SCD2, reconstructed. A version runs from the first day an attribute set
-- was observed to the day before the next distinct set appeared.
CREATE OR REPLACE VIEW listing_versions AS
WITH observed AS (
    SELECT
        * EXCLUDE (
            location_is_exact, location_exact_address, location_subtitle,
            location_verified, str_registration_id
        ),
        -- NULL for a day whose page fetch failed, so the carry-forward
        -- below skips it. Carrying the whole struct rather than each column
        -- individually is what preserves "read the page, no registration
        -- number" (a non-NULL struct holding a NULL) as distinct from "did
        -- not read the page" (a NULL struct).
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
-- Every row in a group carries an identical version_key by construction, so
-- any_value is a pick, not a guess.
aggregated AS (
    SELECT
        listing_id,
        version_no,
        min(scrape_date) AS valid_from,
        max(scrape_date) AS version_last_seen_date,
        any_value(name) AS name,
        any_value(property_title) AS property_title,
        any_value(bedrooms) AS bedrooms,
        any_value(beds) AS beds,
        any_value(bathrooms) AS bathrooms,
        any_value(guest_capacity) AS guest_capacity,
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
    lead(valid_from) OVER (PARTITION BY listing_id ORDER BY version_no) AS valid_to
FROM aggregated;

-- The dimension every downstream query reads.
CREATE OR REPLACE VIEW listings AS
SELECT
    v.listing_id,
    v.name,
    v.property_title,
    v.bedrooms,
    v.beds,
    v.bathrooms,
    v.guest_capacity,
    v.location_lat,
    v.location_lng,
    v.url,
    v.badges,
    v.location_is_exact,
    v.location_exact_address,
    v.location_subtitle,
    v.location_verified,
    v.str_registration_id,
    a.page_seen_date,
    a.first_seen_date,
    a.last_seen_date,
    v.version_no,
    v.version_last_seen_date,
    v.valid_from,
    v.valid_to,
    v.valid_to IS NULL AND a.is_current AS is_current
FROM listing_versions v
JOIN listing_activity a USING (listing_id);

CREATE OR REPLACE VIEW listings_current AS
SELECT * FROM listings WHERE is_current;

-- Calendar rows worth believing.
--
-- When a listing is retired we stop fetching its calendar, so its forward
-- nights freeze with is_current = true and stay that way for up to twelve
-- months. Reading \`calendar_status WHERE is_current\` therefore counts long
-- gone listings as operating on future nights. Nights up to the listing's
-- last_seen_date are still real observations of a listing that was
-- operating, and dropping those would erase genuine history -- so the cut is
-- by night, not by listing.
CREATE OR REPLACE VIEW calendar_current AS
SELECT c.*
FROM calendar_status c
JOIN listing_activity a USING (listing_id)
WHERE c.is_current
  AND (a.is_current OR c.night_date <= a.last_seen_date);
`;

function viewsSql(): string {
  return VIEWS_SQL.replace('{grace}', String(config.RETIREMENT_GRACE_DAYS))
    .replace('{page_attrs}', PAGE_ATTRS_SQL)
    .replace('{version_key}', VERSION_KEY_SQL);
}

/** Raised for a database written before `listings` became a view. */
export class LegacySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacySchemaError';
  }
}

const NO_MIGRATION =
  "There is no migration: see CONTRIBUTING.md, 'When the published database becomes unreadable'.";

/**
 * Fail loudly rather than half-adopting an incompatible file.
 *
 * A database with `listings` as a table stores version *intervals*, not
 * daily observations, and there is no migration from it on purpose:
 * expanding intervals back into daily rows would invent observations on days
 * that may not have had a run. Starting the archive over is better than
 * publishing fabricated scrape dates.
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
  if (columns.length > 0 && !columns.some((row) => row.column_name === 'page_fetch_ok')) {
    throw new LegacySchemaError(
      `\`listing_observations\` has no listing-page columns. ${NO_MIGRATION}`,
    );
  }
}

/** Open (or create) the database, rejecting an incompatible file, and refresh the views. */
export async function connect(path: string): Promise<Database> {
  const db = await Database.open(path);
  await rejectLegacySchema(db);
  await db.run(SCHEMA_SQL);
  await db.run(viewsSql());
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

/**
 * Column order for the daily insert. Kept as one list so the appender, its
 * types and the row builder can't drift apart.
 */
const OBSERVATION_COLUMNS = [
  ['listing_id', BIGINT],
  ['scrape_date', DATE],
  ['name', VARCHAR],
  ['property_title', VARCHAR],
  ['bedrooms', INTEGER],
  ['beds', INTEGER],
  ['bathrooms', DOUBLE],
  ['guest_capacity', INTEGER],
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
] as const satisfies ReadonlyArray<readonly [string, DuckDBType]>;

const OBSERVATION_TYPES = OBSERVATION_COLUMNS.map(([, type]) => type);

/**
 * Write one day's listing observations and report what changed.
 *
 * Idempotent per scrape date: re-running a day replaces its rows rather than
 * adding a second set, which matters because a run that fails the quality
 * gate is expected to be re-run.
 *
 * `pages` is whatever the listing-page pass returned this run; a listing
 * whose page failed (or that had no page fetched at all) records
 * `page_fetch_ok = false` and NULL page columns. The view carries the last
 * good read forward, so this does not read as the host having removed their
 * registration number.
 *
 * `changed` and `retired` are read back out of the views rather than
 * computed alongside the insert, so the run log can never disagree with what
 * a later query sees.
 */
export async function recordObservations(
  db: Database,
  scrapeDate: IsoDate,
  parsed: readonly ParsedListing[],
  pages: readonly ListingPage[] = [],
): Promise<ObservationStats> {
  const byRoom = new Map<bigint, ListingPage>();
  for (const page of pages) {
    if (!page.error) byRoom.set(BigInt(page.roomId), page);
  }

  await db.run('DELETE FROM listing_observations WHERE scrape_date = CAST(? AS DATE)', [scrapeDate]);
  // After the delete, so re-running a day doesn't count its own previous
  // rows as prior history and report every listing as already known.
  // `BIGINT` reads back as a decimal string, which is exactly what `BigInt`
  // takes — no precision is lost on the way through.
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
      appendRow(appender, OBSERVATION_TYPES, [
        listing.listingId,
        day,
        listing.name,
        listing.propertyTitle,
        listing.bedrooms,
        listing.beds,
        listing.bathrooms,
        listing.guestCapacity,
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
      ] satisfies DuckDBValue[]);
    }
    appender.flushSync();
    appender.closeSync();
  }

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
 * How many listings crossed the retirement threshold on this date.
 *
 * Retirement is a view predicate, so there is nothing to update — but the
 * run log still wants the number. A listing counts as retired *today* if
 * it was current yesterday and isn't today, which under
 * `last_seen >= scrape_date - grace` reduces to its last observation falling
 * exactly `grace + 1` days ago.
 *
 * This is a per-run statistic, so it assumes runs happen daily; a gap in
 * runs shifts which day the transition is reported on,
 * without changing whether the listing is current.
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
 * One run's listing-page pass, summarized for logging and the quality gate.
 *
 * Parse provenance (`ListingPage.locationSource`) lives here and in the
 * logs, not in the database — which extraction layer produced a value is a
 * fact about the scraper, not about the listing.
 */
export interface PageFetchStats {
  attempted: number;
  failed: number;
  exactLocated: number;
  registered: number;
  /**
   * Parse health: how many fetched pages yielded Airbnb's exact-location
   * flag at all, and how many each extraction layer contributed to. The
   * data-quality gate reads these to catch a layer dying silently.
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
    withExactFlag: ok.filter((page) => page.locationIsExact !== null).length,
    layerUsed,
  };
}

// --------------------------------------------------------------------------
// calendar

export interface CalendarMergeStats {
  attempted: number;
  failed: number;
  nightsChanged: number;
}

const STAGING_TYPES = [BIGINT, DATE, BOOLEAN, INTEGER, DOUBLE] satisfies DuckDBType[];

const CALENDAR_INSERT_TYPES = [
  BIGINT,
  DATE,
  BOOLEAN,
  INTEGER,
  DOUBLE,
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
  price_amount: number | null;
  status_hash: string;
}

/**
 * SCD2-merge one run's calendar.
 *
 * Still change-only, unlike listings: a snapshot per night per day is ~350M
 * rows/year, so the merge earns its complexity here. See the module
 * docstring.
 */
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
      '(listing_id BIGINT, night_date DATE, available BOOLEAN, min_nights INTEGER, ' +
      'price_amount DOUBLE)',
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
        night.priceAmount,
      ]);
    }
  }
  staging.flushSync();
  staging.closeSync();

  await db.run('ALTER TABLE stg_calendar ADD COLUMN status_hash VARCHAR');
  await db.run(
    "UPDATE stg_calendar SET status_hash = md5(available::VARCHAR || '|' || " +
      "coalesce(min_nights::VARCHAR,'') || '|' || coalesce(price_amount::VARCHAR,''))",
  );

  const changed = await db.rows<ChangedNight>(
    'SELECT s.listing_id, s.night_date, s.available, s.min_nights, s.price_amount, s.status_hash ' +
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
      night.price_amount,
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
  errorSummary: string | null;
}

export async function logRun(db: Database, run: RunRow): Promise<void> {
  await db.run(
    'INSERT INTO scrape_runs ' +
      '(scrape_date, run_started_at, run_finished_at, listings_seen, listings_new, ' +
      ' listings_changed, listings_retired, calendar_fetch_attempted, calendar_fetch_failed, ' +
      ' calendar_nights_changed, page_fetch_attempted, page_fetch_failed, error_summary) ' +
      'VALUES (CAST(? AS DATE), CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), ' +
      '?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      run.errorSummary,
    ],
    // The three date/timestamp parameters are bound as strings and cast in
    // SQL, which is the one spelling that accepts an ISO date, a naive
    // timestamp, and NULL without a type dance.
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
      VARCHAR,
    ],
  );
}
