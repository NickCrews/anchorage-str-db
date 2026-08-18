"""DuckDB schema and SCD2 merge logic.

Three tables:

- `listings` — SCD2 dimension, one row per *version* of a listing. A new
  version is only opened when `attr_hash` changes (name, bed/bath counts,
  coordinates, badges). `last_seen_date` bumps every run a listing is still
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
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date

import duckdb

from girdwood_str.airbnb_client import CalendarResult
from girdwood_str.parse import ParsedListing

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
    lat DOUBLE,
    lng DOUBLE,
    url VARCHAR,
    badges VARCHAR[],
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
    error_summary VARCHAR
);
"""


def connect(db_path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_SQL)
    return con


@dataclass
class ListingMergeStats:
    seen: int = 0
    new: int = 0
    changed: int = 0


def merge_listings(
    con: duckdb.DuckDBPyConnection, scrape_date: date, parsed: list[ParsedListing]
) -> ListingMergeStats:
    stats = ListingMergeStats(seen=len(parsed))

    con.execute(
        "CREATE OR REPLACE TEMP TABLE stg_listings ("
        "listing_id BIGINT, name VARCHAR, property_title VARCHAR, bedrooms INTEGER, "
        "beds INTEGER, bathrooms DOUBLE, guest_capacity INTEGER, lat DOUBLE, lng DOUBLE, "
        "url VARCHAR, badges VARCHAR[], attr_hash VARCHAR)"
    )
    if parsed:
        con.executemany(
            "INSERT INTO stg_listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                    p.attr_hash,
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
                 guest_capacity, lat, lng, url, badges, attr_hash,
                 first_seen_date, last_seen_date, valid_from, valid_to, is_current)
            SELECT
                s.listing_id, s.name, s.property_title, s.bedrooms, s.beds, s.bathrooms,
                s.guest_capacity, s.lat, s.lng, s.url, s.badges, s.attr_hash,
                coalesce(prior.first_seen_date, ?), ?, ?, NULL, true
            FROM stg_listings s
            LEFT JOIN listings prior
                ON prior.listing_id = s.listing_id AND prior.valid_to = ?
            WHERE s.listing_id = ANY(?)
            """,
            [scrape_date, scrape_date, scrape_date, scrape_date, changed_ids],
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
        " calendar_nights_changed, error_summary) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            run.get("error_summary"),
        ],
    )
