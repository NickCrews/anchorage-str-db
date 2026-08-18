"""The daily verb: search Girdwood, fetch every listing's calendar, merge
both into the DuckDB store, log the run. One function, `run_daily`, is the
entire pipeline — small enough that CLI, tests, and GitHub Actions all call
the same thing.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from pathlib import Path

from girdwood_str import airbnb_client, checks, config, store
from girdwood_str.parse import parse_listing

log = logging.getLogger(__name__)


def run_daily(db_path: Path, scrape_date: date | None = None) -> bool:
    """Run one full daily scrape + merge + quality gate. Returns True iff it passed."""
    scrape_date = scrape_date or datetime.now(UTC).date()
    started = datetime.now(UTC)
    log.info("=== girdwood-str daily run: %s ===", scrape_date)

    con = store.connect(db_path)
    error_summary = None
    try:
        raw_results = airbnb_client.search_girdwood()
        parsed_by_id = {}
        for raw in raw_results:
            p = parse_listing(raw)
            if p is not None:
                parsed_by_id[p.listing_id] = p  # de-dupe: keep last occurrence
        parsed = list(parsed_by_id.values())
        log.info("parsed %d distinct listings (from %d raw results)", len(parsed), len(raw_results))

        listing_stats = store.merge_listings(con, scrape_date, parsed)
        store.insert_observations(con, scrape_date, parsed)
        retired = store.retire_stale_listings(con, scrape_date, config.RETIREMENT_GRACE_DAYS)

        room_ids = [str(p.listing_id) for p in parsed]
        calendar_results = airbnb_client.fetch_calendars(room_ids)
        calendar_stats = store.merge_calendar(con, scrape_date, calendar_results)

        store.log_run(
            con,
            dict(
                scrape_date=scrape_date,
                run_started_at=started,
                run_finished_at=datetime.now(UTC),
                listings_seen=listing_stats.seen,
                listings_new=listing_stats.new,
                listings_changed=listing_stats.changed,
                listings_retired=retired,
                calendar_fetch_attempted=calendar_stats.attempted,
                calendar_fetch_failed=calendar_stats.failed,
                calendar_nights_changed=calendar_stats.nights_changed,
                error_summary=None,
            ),
        )
    except Exception as e:
        error_summary = f"{type(e).__name__}: {e}"
        log.exception("daily run failed")
        store.log_run(
            con,
            dict(
                scrape_date=scrape_date,
                run_started_at=started,
                run_finished_at=datetime.now(UTC),
                listings_seen=None,
                listings_new=None,
                listings_changed=None,
                listings_retired=None,
                calendar_fetch_attempted=None,
                calendar_fetch_failed=None,
                calendar_nights_changed=None,
                error_summary=error_summary,
            ),
        )
        con.close()
        raise

    results = checks.run_checks(con, scrape_date)
    ok = checks.report(results)
    con.close()

    if error_summary:
        ok = False
    log.info("=== run %s: %s ===", scrape_date, "PASSED" if ok else "FAILED")
    return ok
