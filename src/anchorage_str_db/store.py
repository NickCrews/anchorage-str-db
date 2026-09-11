"""DuckDB schema and merge logic.

Two grains of observation, one run log, and a set of views that reconstruct
the slowly-changing dimensions on top of them.

- `listing_observations` — append-only, one row per (listing, day) it was
  seen in search results. Everything we learned about the listing that day:
  the search fields, the listing-page fields, and the volatile stuff
  (rating, review count, nightly price hint). This is the source of truth;
  nothing else about a listing is stored.
- `calendar_status` — SCD2 on (listing_id, night_date): whether that night
  was available, as observed. Once a night_date scrolls out of Airbnb's
  ~12-month forward calendar window, we simply stop observing it, so its
  last known value freezes in place — which is exactly the realized
  booked/available call for a night once it's in the past. No special
  "close out old nights" logic is needed for that; see README for the
  caveat that "not available" conflates real bookings with host blocks.
- `scrape_runs` — one row per run, for freshness and failure tracking.

Why `listings` is a view and `calendar_status` is a table
--------------------------------------------------------
Both used to be SCD2 tables, on the reasoning that a snapshot-per-day would
be unaffordable. That reasoning is sound for the calendar and wrong for
listings, by a factor of about 400:

- calendar: ~2600 listings x ~365 forward nights = ~950k rows/day,
  ~350M/year. Storing a row per night per day is genuinely infeasible, so
  it earns its merge logic.
- listings: ~2600 rows/day, ~950k/year — and the most compressible data
  imaginable, the same twenty columns repeating verbatim. Change-only
  merging bought nothing here and cost a mutable, hand-maintained history.

So `listings` is now derived: `listing_versions` runs gaps-and-islands over
the daily rows to rebuild `valid_from`/`valid_to`, and `listing_activity`
aggregates first/last/page-seen dates. Same column names as the old table,
so `WHERE is_current` keeps working for every downstream query.

Three things fall out of that which the table couldn't do:

1. `first_seen_date` and `last_seen_date` stop being able to disagree with
   the observations, because they *are* the observations. The old table
   computed them with an UPDATE and a carry-forward join that both missed
   the case of a listing retiring and later coming back, silently resetting
   its first-seen date and blanking its registration number.
2. History is recomputable. Runs mutate an append-only table, so a bug in
   the version logic is fixed by editing a view, not by backfilling a
   database that is itself the only copy (see CONTRIBUTING: the published
   .duckdb file is downloaded, mutated, and re-uploaded each run).
3. Freshness is answerable per field — `max(scrape_date) FILTER (WHERE
   <field> IS NOT NULL)` — rather than only for the questions someone
   thought to add a `*_seen_date` column for.

The listing-page fields (`location_is_exact`, `str_registration_id`, ...)
sit on the same row as the search fields rather than in a table of their
own, even though they come from a second endpoint that fails independently.
They describe the listing, not an event, and `location_is_exact` in
particular is a modifier on the `location_lat`/`location_lng` columns
sitting right next to it — splitting them would mean no query could read a
coordinate without a join, which is how you end up with analyses that
quietly treat jittered pins as real addresses.

`page_fetch_ok` is what makes that safe to store per-day: a day we couldn't
read the page records NULLs and `false`, and the *view* carries the last
successful read forward. The raw row stays honest about what we actually
saw, which the old carry-forward-on-write destroyed.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, timedelta

import duckdb

from anchorage_str_db import config
from anchorage_str_db.airbnb_client import CalendarResult
from anchorage_str_db.listing_page import ListingPage
from anchorage_str_db.parse import ParsedListing

log = logging.getLogger(__name__)

SCHEMA_SQL = """
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
    -- independently. `page_fetch_ok` distinguishes "we read the page and
    -- this host publishes no STR number" from "we never got to look" —
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
"""

# Attributes whose change opens a new listing version. Volatile columns
# (rating, review count, price hint) are excluded on purpose — they belong
# to the day, not to the listing — and so is `url`, which is a function of
# `listing_id`. Coordinates are rounded to 6dp so float noise in Airbnb's
# response doesn't read as the listing having moved.
_VERSION_KEY_SQL = """{
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
}"""

_PAGE_ATTRS_SQL = """{
    'location_is_exact': location_is_exact,
    'location_exact_address': location_exact_address,
    'location_subtitle': location_subtitle,
    'location_verified': location_verified,
    'str_registration_id': str_registration_id
}"""

# `{grace}` is filled from config.RETIREMENT_GRACE_DAYS. The views are
# CREATE OR REPLACE'd on every connect(), so changing that constant takes
# effect on the next run rather than needing a rebuild.
VIEWS_SQL = """
-- The date retirement is measured back from: the most recent run that
-- actually completed its write phase.
--
-- Not simply `max(scrape_date)` from the observations, because that stops
-- advancing exactly when it matters — a run where every listing had
-- vanished would write no rows, freeze the clock, and leave every dead
-- listing reading as current forever. Not `max(scrape_date)` from
-- `scrape_runs` either, because a *failed* run logs a row there with all
-- counts NULL, and a run that scraped nothing must not retire anything.
-- `listings_seen IS NOT NULL` is the marker for a run that got as far as
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

-- The dimension every downstream query reads. Same shape the SCD2 table
-- had, so `WHERE is_current` still means what it always did.
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
-- months. Reading `calendar_status WHERE is_current` therefore counts long
-- gone listings as operating on future nights. Nights up to the listing's
-- last_seen_date are still real observations of a listing that was
-- operating, and dropping those would erase genuine history — so the cut is
-- by night, not by listing.
CREATE OR REPLACE VIEW calendar_current AS
SELECT c.*
FROM calendar_status c
JOIN listing_activity a USING (listing_id)
WHERE c.is_current
  AND (a.is_current OR c.night_date <= a.last_seen_date);
"""


def _views_sql() -> str:
    return VIEWS_SQL.format(
        grace=config.RETIREMENT_GRACE_DAYS,
        page_attrs=_PAGE_ATTRS_SQL,
        version_key=_VERSION_KEY_SQL,
    )


class LegacySchemaError(RuntimeError):
    """Raised for a database written before `listings` became a view."""


_NO_MIGRATION = (
    "There is no migration: see CONTRIBUTING.md, "
    "'When the published database becomes unreadable'."
)


def _reject_legacy_schema(con: duckdb.DuckDBPyConnection) -> None:
    """Fail loudly rather than half-adopting an old file.

    There is no migration path on purpose (see the dropped migration
    machinery in git history): the observations table is the source of
    truth, and the old SCD2 table stored date *intervals*, so expanding it
    back into daily rows would invent observations on days that may not have
    had a run. Better to start the archive over than to publish fabricated
    scrape dates.
    """
    if con.execute(
        "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'listings'"
    ).fetchone()[0]:
        raise LegacySchemaError(
            "this database has `listings` as a table, from the pre-view schema. " + _NO_MIGRATION
        )
    columns = {
        row[0]
        for row in con.execute(
            "SELECT column_name FROM duckdb_columns() "
            "WHERE table_name = 'listing_observations'"
        ).fetchall()
    }
    if columns and "page_fetch_ok" not in columns:
        raise LegacySchemaError(
            "`listing_observations` predates the listing-page columns. " + _NO_MIGRATION
        )


def connect(db_path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    _reject_legacy_schema(con)
    con.execute(SCHEMA_SQL)
    con.execute(_views_sql())
    return con


@contextmanager
def transaction(con: duckdb.DuckDBPyConnection):
    """Group a run's writes into one all-or-nothing unit.

    DuckDB's Python client autocommits every statement, so without this each
    statement a run issues is independently durable and a crash part-way
    leaves a half-written scrape date on disk — listings recorded but no
    calendar, or the reverse.

    A scrape date is the unit that carries meaning here: every table is keyed
    by it and the quality gate judges one. A partially written day isn't a
    smaller true thing, it's a false one, because nothing in the schema marks
    it as partial.

    Catches BaseException, not Exception, so a Ctrl-C mid-run rolls back too
    — that's the failure this most often protects against in local use.
    """
    con.execute("BEGIN TRANSACTION")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    con.execute("COMMIT")


@dataclass
class ObservationStats:
    seen: int = 0
    new: int = 0
    changed: int = 0
    retired: int = 0


# Column order for the daily insert. Kept as one tuple so the INSERT, its
# placeholders, and the row builder can't drift apart.
_OBSERVATION_COLUMNS = (
    "listing_id",
    "scrape_date",
    "name",
    "property_title",
    "bedrooms",
    "beds",
    "bathrooms",
    "guest_capacity",
    "location_lat",
    "location_lng",
    "url",
    "badges",
    "rating_value",
    "review_count",
    "price_hint_per_night",
    "price_qualifier",
    "page_fetch_ok",
    "location_is_exact",
    "location_exact_address",
    "location_subtitle",
    "location_verified",
    "str_registration_id",
)

_PAGE_COLUMNS = (
    "location_is_exact",
    "location_exact_address",
    "location_subtitle",
    "location_verified",
    "str_registration_id",
)


def record_observations(
    con: duckdb.DuckDBPyConnection,
    scrape_date: date,
    parsed: list[ParsedListing],
    pages: list[ListingPage] | None = None,
) -> ObservationStats:
    """Write one day's listing observations and report what changed.

    Idempotent per scrape date: re-running a day replaces its rows rather
    than adding a second set, which matters because a run that fails the
    quality gate is expected to be re-run.

    `pages` is whatever `listing_page.fetch_listing_pages` returned this run;
    a listing whose page failed (or that had no page fetched at all) records
    `page_fetch_ok = false` and NULL page columns. The view carries the last
    good read forward, so this does not read as the host having removed
    their registration number.

    `changed` and `retired` are read back out of the views rather than
    computed alongside the insert, so the run log can never disagree with
    what a later query sees.
    """
    by_room = {int(p.room_id): p for p in (pages or []) if not p.error}

    con.execute("DELETE FROM listing_observations WHERE scrape_date = ?", [scrape_date])
    # After the delete, so re-running a day doesn't count its own previous
    # rows as prior history and report every listing as already known.
    previously_seen = {
        row[0]
        for row in con.execute("SELECT DISTINCT listing_id FROM listing_observations").fetchall()
    }

    rows = []
    for p in parsed:
        page = by_room.get(p.listing_id)
        rows.append(
            (
                p.listing_id,
                scrape_date,
                p.name,
                p.property_title,
                p.bedrooms,
                p.beds,
                p.bathrooms,
                p.guest_capacity,
                p.lat,
                p.lng,
                p.url,
                p.badges,
                p.rating_value,
                p.review_count,
                p.price_hint_per_night,
                p.price_qualifier,
                page is not None,
                *(getattr(page, attr) if page else None for attr in _PAGE_COLUMNS),
            )
        )
    if rows:
        placeholders = ", ".join("?" * len(_OBSERVATION_COLUMNS))
        con.executemany(
            f"INSERT INTO listing_observations ({', '.join(_OBSERVATION_COLUMNS)}) "
            f"VALUES ({placeholders})",
            rows,
        )

    return ObservationStats(
        seen=len(parsed),
        new=sum(1 for p in parsed if p.listing_id not in previously_seen),
        changed=con.execute(
            "SELECT count(*) FROM listing_versions WHERE valid_from = ?", [scrape_date]
        ).fetchone()[0],
        retired=count_newly_retired(con, scrape_date, config.RETIREMENT_GRACE_DAYS),
    )


def count_newly_retired(
    con: duckdb.DuckDBPyConnection, scrape_date: date, grace_days: int
) -> int:
    """How many listings crossed the retirement threshold on this date.

    Retirement is a view predicate now, so there is nothing to update — but
    the run log still wants the number. A listing counts as retired *today*
    if it was current yesterday and isn't today, which under
    `last_seen >= scrape_date - grace` reduces to its last observation
    falling exactly `grace + 1` days ago.

    This is a per-run statistic, so like the old UPDATE it assumes runs
    happen daily; a gap in runs shifts which day the transition is reported
    on, without changing whether the listing is current.
    """
    return con.execute(
        "SELECT count(*) FROM (SELECT listing_id FROM listing_observations "
        "GROUP BY listing_id HAVING max(scrape_date) = ?)",
        [scrape_date - timedelta(days=grace_days + 1)],
    ).fetchone()[0]


@dataclass
class PageFetchStats:
    """One run's listing-page pass, summarized for logging and the quality
    gate. Parse provenance (`ListingPage.location_source`) lives here and in
    the logs, not in the database — which extraction layer produced a value
    is a fact about the scraper, not about the listing."""

    attempted: int = 0
    failed: int = 0
    exact_located: int = 0
    registered: int = 0
    # Parse health: how many fetched pages yielded Airbnb's exact-location
    # flag at all, and how many each extraction layer contributed to. The
    # data-quality gate reads these to catch a layer dying silently.
    with_exact_flag: int = 0
    layer_used: dict[str, int] = field(default_factory=dict)

    @classmethod
    def of(cls, pages: list[ListingPage]) -> PageFetchStats:
        ok = [p for p in pages if not p.error]
        return cls(
            attempted=len(pages),
            failed=len(pages) - len(ok),
            exact_located=sum(1 for p in ok if p.location_is_exact),
            registered=sum(1 for p in ok if p.str_registration_id),
            with_exact_flag=sum(1 for p in ok if p.location_is_exact is not None),
            layer_used={
                layer: sum(1 for p in ok if layer in (p.location_source or "").split("+"))
                for layer in ("json-ld", "state", "raw-html")
            },
        )


@dataclass
class CalendarMergeStats:
    attempted: int = 0
    failed: int = 0
    nights_changed: int = 0


def merge_calendar(
    con: duckdb.DuckDBPyConnection, scrape_date: date, results: list[CalendarResult]
) -> CalendarMergeStats:
    """SCD2-merge one run's calendar. Still change-only, unlike listings:
    a snapshot per night per day is ~350M rows/year, so the merge earns its
    complexity here. See the module docstring."""
    stats = CalendarMergeStats(attempted=len(results), failed=sum(1 for r in results if r.error))
    rows = [
        (int(r.room_id), n.night_date, n.available, n.min_nights, n.price_amount)
        for r in results
        if not r.error
        for n in r.nights
    ]
    if not rows:
        return stats

    con.execute(
        "CREATE OR REPLACE TEMP TABLE stg_calendar "
        "(listing_id BIGINT, night_date DATE, available BOOLEAN, min_nights INTEGER, price_amount DOUBLE)"
    )
    con.executemany("INSERT INTO stg_calendar VALUES (?, ?, ?, ?, ?)", rows)
    con.execute("ALTER TABLE stg_calendar ADD COLUMN status_hash VARCHAR")
    con.execute(
        "UPDATE stg_calendar SET status_hash = md5("
        "available::VARCHAR || '|' || coalesce(min_nights::VARCHAR,'') || '|' || coalesce(price_amount::VARCHAR,''))"
    )

    changed = con.execute(
        "SELECT s.listing_id, s.night_date, s.available, s.min_nights, s.price_amount, s.status_hash "
        "FROM stg_calendar s "
        "LEFT JOIN calendar_status c "
        "  ON c.listing_id = s.listing_id AND c.night_date = s.night_date AND c.is_current "
        "WHERE c.listing_id IS NULL OR c.status_hash != s.status_hash"
    ).fetchall()
    stats.nights_changed = len(changed)
    if not changed:
        return stats

    con.execute(
        """
        UPDATE calendar_status SET valid_to = ?, is_current = false
        WHERE is_current AND (listing_id, night_date) IN (
            SELECT s.listing_id, s.night_date FROM stg_calendar s
            JOIN calendar_status c
              ON c.listing_id = s.listing_id AND c.night_date = s.night_date AND c.is_current
            WHERE c.status_hash != s.status_hash
        )
        """,
        [scrape_date],
    )
    con.executemany(
        "INSERT INTO calendar_status "
        "(listing_id, night_date, available, min_nights, price_amount, status_hash, valid_from, valid_to, is_current) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, true)",
        [(lid, nd, avail, mn, pa, sh, scrape_date) for lid, nd, avail, mn, pa, sh in changed],
    )
    return stats


def log_run(con: duckdb.DuckDBPyConnection, run: dict) -> None:
    con.execute(
        "INSERT INTO scrape_runs "
        "(scrape_date, run_started_at, run_finished_at, listings_seen, listings_new, "
        " listings_changed, listings_retired, calendar_fetch_attempted, calendar_fetch_failed, "
        " calendar_nights_changed, page_fetch_attempted, page_fetch_failed, error_summary) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            run["scrape_date"],
            run["run_started_at"],
            run["run_finished_at"],
            run["listings_seen"],
            run["listings_new"],
            run["listings_changed"],
            run["listings_retired"],
            run["calendar_fetch_attempted"],
            run["calendar_fetch_failed"],
            run["calendar_nights_changed"],
            run.get("page_fetch_attempted"),
            run.get("page_fetch_failed"),
            run.get("error_summary"),
        ],
    )
