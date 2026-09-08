"""DuckDB schema and SCD2 merge logic.

Three tables:

- `listings` — SCD2 dimension, one row per *version* of a listing. A new
  version is only opened when `attr_hash` changes (name, bed/bath counts,
  coordinates, badges, whether the coordinate is Airbnb's real one or its
  jitter, and the municipal STR registration number). `last_seen_date` bumps every run a listing is still
  seen in search results, independent of attr_hash — that's what lets
  `retire_stale_listings` distinguish "hasn't changed" from "hasn't been
  seen," instead of closing a listing's version on the first pagination
  hiccup that momentarily drops it from a search page.
- `listing_observations` — append-only, one row per (listing, day) it was
  seen active in search results: rating, review count, a rough nightly
  price hint. This is what answers "how many distinct STRs operated over
  the last year" (`count(distinct listing_id)` with a date filter) without
  disturbing the slow-moving `listings` dimension.
- `calendar_status` — SCD2 on (listing_id, night_date): whether that night
  was available, as observed. Once a night_date scrolls out of Airbnb's
  ~12-month forward calendar window, we simply stop observing it, so its
  last known value freezes in place — which is exactly the realized
  booked/available call for a night once it's in the past. No special
  "close out old nights" logic is needed for that; see README for the
  caveat that "not available" conflates real bookings with host blocks.

The listing-page fields (`location_is_exact`, `str_registration_id`, …)
live on `listings` rather than in a table of their own, even though they
come from a second endpoint on a slower cadence. They describe the listing,
not an event, and `location_is_exact` in particular is a modifier on the
`location_lat`/`location_lng` columns sitting right next to it — splitting
them would mean no query could read a coordinate without a join, which is
how you end up with analyses that quietly treat jittered pins as real
addresses.

That the page fetch can fail independently is handled by carrying the
previous version's values forward (see `_carried_locations`), not by
storing them apart: a listing whose page we couldn't read this run keeps
what we last knew about it, rather than flapping to NULL and back.
"""

from __future__ import annotations

import hashlib
import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date

import duckdb

from anchorage_str_db.airbnb_client import CalendarResult
from anchorage_str_db.listing_page import ListingPage
from anchorage_str_db.parse import ParsedListing

log = logging.getLogger(__name__)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS listings (
    listing_id BIGINT NOT NULL,
    name VARCHAR,
    property_title VARCHAR,
    bedrooms INTEGER,
    beds INTEGER,
    bathrooms DOUBLE,
    guest_capacity INTEGER,
    -- `location_lat`/`location_lng` come from search and exist for every
    -- listing; the rest of the location_* columns come from the listing's
    -- own page, and are NULL for rows written before that pass existed or
    -- where the page fetch failed. `location_is_exact` says whether the
    -- coordinate is the listing's real position or Airbnb's jitter.
    location_lat DOUBLE,
    location_lng DOUBLE,
    url VARCHAR,
    badges VARCHAR[],
    location_is_exact BOOLEAN,
    location_exact_address VARCHAR,
    location_subtitle VARCHAR,
    location_verified BOOLEAN,
    str_registration_id VARCHAR,
    -- When we last read this listing's page: distinguishes "never fetched"
    -- from "fetched, and this host publishes no STR number." Updates in
    -- place like `last_seen_date`; not part of `attr_hash`.
    page_seen_date DATE,
    attr_hash VARCHAR NOT NULL,
    first_seen_date DATE NOT NULL,
    last_seen_date DATE NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    is_current BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_observations (
    listing_id BIGINT NOT NULL,
    scrape_date DATE NOT NULL,
    rating_value DOUBLE,
    review_count INTEGER,
    price_hint_per_night DOUBLE,
    price_qualifier VARCHAR,
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


# Renames applied to an already-published database. CREATE TABLE IF NOT
# EXISTS is a no-op on an existing database, so schema changes need explicit
# ALTERs — this is the project's whole migration story, and it works because
# the daily job carries the previous day's file forward rather than
# rebuilding from scratch (see CONTRIBUTING.md). DuckDB has no RENAME COLUMN
# IF EXISTS, hence the check against the live column list.
_LISTINGS_RENAMES = {
    "lat": "location_lat",
    "lng": "location_lng",
}

_MIGRATIONS_SQL = """
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS page_fetch_attempted INTEGER;
ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS page_fetch_failed INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS location_is_exact BOOLEAN;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS location_exact_address VARCHAR;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS location_subtitle VARCHAR;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS location_verified BOOLEAN;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS str_registration_id VARCHAR;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS page_seen_date DATE;
"""


def _migrate(con: duckdb.DuckDBPyConnection) -> None:
    columns = {
        row[0]
        for row in con.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'listings'"
        ).fetchall()
    }
    for old, new in _LISTINGS_RENAMES.items():
        if old in columns and new not in columns:
            con.execute(f"ALTER TABLE listings RENAME COLUMN {old} TO {new}")
    con.execute(_MIGRATIONS_SQL)


def connect(db_path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_SQL)
    _migrate(con)
    return con


@contextmanager
def transaction(con: duckdb.DuckDBPyConnection):
    """Group a run's writes into one all-or-nothing unit.

    DuckDB's Python client autocommits every statement, so without this each
    of the ~8 statements a run issues is independently durable and a crash
    part-way leaves a half-written scrape date on disk — listings merged but
    no calendar, or (worse, inside `merge_listings`) versions closed with
    their replacements never inserted, silently dropping listings out of
    `is_current`.

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


def listing_attr_hash(parsed: ParsedListing, location_attrs: tuple) -> str:
    """The SCD2 change key: search attributes plus listing-page attributes.

    `ParsedListing.attr_hash` covers only what search returns. Folding the
    listing-page values in here is what makes a host toggling their exact
    location on, or adding a registration number, open a dated new version
    rather than silently overwriting the current one — which is the whole
    reason those fields are worth storing over time.
    """
    return hashlib.md5(f"{parsed.attr_hash}|{location_attrs!r}".encode()).hexdigest()


@dataclass
class ListingMergeStats:
    seen: int = 0
    new: int = 0
    changed: int = 0


# Listing-page attributes: things about the listing itself, so they go into
# `attr_hash` and a change to any of them opens a dated new version.
# `page_seen_date` is deliberately not here: it describes the *observation*,
# not the listing, so it updates in place on the current version — exactly
# like `last_seen_date`. Putting it in the hash would open a new version
# every single day the pass runs, which is the snapshot-per-day
# anti-pattern this schema exists to avoid.
_LOCATION_ATTRS = (
    "location_is_exact",
    "location_exact_address",
    "location_subtitle",
    "location_verified",
    "str_registration_id",
)


def _carried_locations(con: duckdb.DuckDBPyConnection, listing_ids: list[int]) -> dict[int, tuple]:
    """Each listing's current listing-page values, to carry forward.

    A run where a particular page fetch failed must not blank these out —
    "we couldn't look today" is not the same fact as "this listing no longer
    publishes a registration number," and letting them flap to NULL would
    open a spurious SCD2 version every other day.
    """
    if not listing_ids:
        return {}
    rows = con.execute(
        f"SELECT listing_id, {', '.join(_LOCATION_ATTRS)} FROM listings "
        f"WHERE is_current AND listing_id = ANY(?)",
        [listing_ids],
    ).fetchall()
    return {row[0]: tuple(row[1:]) for row in rows}


def _location_attrs(page: ListingPage | None, carried: tuple | None) -> tuple:
    if page is None or page.error:
        return carried if carried is not None else (None,) * len(_LOCATION_ATTRS)
    return tuple(getattr(page, attr) for attr in _LOCATION_ATTRS)


def merge_listings(
    con: duckdb.DuckDBPyConnection,
    scrape_date: date,
    parsed: list[ParsedListing],
    pages: list[ListingPage] | None = None,
) -> ListingMergeStats:
    """SCD2-merge one run's listings, including their listing-page data.

    `pages` is whatever `listing_page.fetch_listing_pages` returned this run.
    It stays optional for tests and for reading a database written before the
    page pass existed; either way the merged row carries listing-page values
    — fresh ones where we have them, yesterday's where a fetch failed — so
    `attr_hash` stays comparable across runs.
    """
    stats = ListingMergeStats(seen=len(parsed))
    by_room = {int(p.room_id): p for p in (pages or []) if not p.error}
    carried = _carried_locations(con, [p.listing_id for p in parsed])

    con.execute(
        "CREATE OR REPLACE TEMP TABLE stg_listings ("
        "listing_id BIGINT, name VARCHAR, property_title VARCHAR, bedrooms INTEGER, "
        "beds INTEGER, bathrooms DOUBLE, guest_capacity INTEGER, location_lat DOUBLE, "
        "location_lng DOUBLE, url VARCHAR, badges VARCHAR[], location_is_exact BOOLEAN, "
        "location_exact_address VARCHAR, location_subtitle VARCHAR, "
        "location_verified BOOLEAN, str_registration_id VARCHAR, attr_hash VARCHAR)"
    )
    if parsed:
        con.executemany(
            "INSERT INTO stg_listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    p.listing_id,
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
                    *(
                        attrs := _location_attrs(
                            by_room.get(p.listing_id), carried.get(p.listing_id)
                        )
                    ),
                    listing_attr_hash(p, attrs),
                )
                for p in parsed
            ],
        )

    # last_seen_date bumps for every currently-seen listing, changed or not.
    con.execute(
        "UPDATE listings SET last_seen_date = ? "
        "WHERE is_current AND listing_id IN (SELECT listing_id FROM stg_listings)",
        [scrape_date],
    )

    changed_ids = con.execute(
        "SELECT s.listing_id FROM stg_listings s "
        "LEFT JOIN listings l ON l.listing_id = s.listing_id AND l.is_current "
        "WHERE l.listing_id IS NULL OR l.attr_hash != s.attr_hash"
    ).fetchall()
    changed_ids = [r[0] for r in changed_ids]
    stats.changed = len(changed_ids)
    stats.new = con.execute(
        "SELECT count(*) FROM stg_listings s "
        "LEFT JOIN listings l ON l.listing_id = s.listing_id "
        "WHERE l.listing_id IS NULL"
    ).fetchone()[0]

    if changed_ids:
        con.execute(
            "UPDATE listings SET valid_to = ?, is_current = false "
            "WHERE is_current AND listing_id = ANY(?)",
            [scrape_date, changed_ids],
        )
        con.execute(
            """
            INSERT INTO listings
                (listing_id, name, property_title, bedrooms, beds, bathrooms,
                 guest_capacity, location_lat, location_lng, url, badges,
                 location_is_exact, location_exact_address, location_subtitle,
                 location_verified, str_registration_id, page_seen_date, attr_hash,
                 first_seen_date, last_seen_date, valid_from, valid_to, is_current)
            SELECT
                s.listing_id, s.name, s.property_title, s.bedrooms, s.beds, s.bathrooms,
                s.guest_capacity, s.location_lat, s.location_lng, s.url, s.badges,
                s.location_is_exact, s.location_exact_address, s.location_subtitle,
                s.location_verified, s.str_registration_id, prior.page_seen_date, s.attr_hash,
                coalesce(prior.first_seen_date, ?), ?, ?, NULL, true
            FROM stg_listings s
            LEFT JOIN listings prior
                ON prior.listing_id = s.listing_id AND prior.valid_to = ?
            WHERE s.listing_id = ANY(?)
            """,
            [scrape_date, scrape_date, scrape_date, scrape_date, changed_ids],
        )

    # Stamp page_seen_date on the (possibly just-inserted) current version of
    # every listing whose page we successfully read this run — an in-place
    # update, exactly like last_seen_date above.
    if by_room:
        con.execute(
            "UPDATE listings SET page_seen_date = ? WHERE is_current AND listing_id = ANY(?)",
            [scrape_date, list(by_room.keys())],
        )
    return stats


def retire_stale_listings(
    con: duckdb.DuckDBPyConnection, scrape_date: date, grace_days: int
) -> int:
    cutoff = f"DATE '{scrape_date}' - INTERVAL {grace_days} DAY"
    result = con.execute(
        f"UPDATE listings SET valid_to = ?, is_current = false "
        f"WHERE is_current AND last_seen_date < {cutoff}",
        [scrape_date],
    )
    return result.fetchone()[0] if result.description else 0


def insert_observations(
    con: duckdb.DuckDBPyConnection, scrape_date: date, parsed: list[ParsedListing]
) -> None:
    con.execute("DELETE FROM listing_observations WHERE scrape_date = ?", [scrape_date])
    con.executemany(
        "INSERT INTO listing_observations "
        "(listing_id, scrape_date, rating_value, review_count, price_hint_per_night, price_qualifier) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                p.listing_id,
                scrape_date,
                p.rating_value,
                p.review_count,
                p.price_hint_per_night,
                p.price_qualifier,
            )
            for p in parsed
        ],
    )


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
