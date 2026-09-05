"""The daily verb: search Anchorage, fetch every listing's calendar, merge
both into the DuckDB store, log the run. One function, `run_daily`, is the
entire pipeline — small enough that CLI, tests, and GitHub Actions all call
the same thing.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from pathlib import Path

from anchorage_str import airbnb_client, checks, config, listing_page, store
from anchorage_str.parse import parse_listing

log = logging.getLogger(__name__)


def run_daily(db_path: Path, scrape_date: date | None = None, fetch_pages: bool = False) -> bool:
    """Run one full daily scrape + merge + quality gate. Returns True iff it passed.

    `fetch_pages` adds a second per-listing pass over each listing's own
    page, for the location payload and STR registration number (see
    `listing_page.py`). It roughly doubles the run's request count, so it's
    opt-in while it's still being evaluated — `anchorage-str-db daily --pages`.
    """
    scrape_date = scrape_date or datetime.now(UTC).date()
    started = datetime.now(UTC)
    log.info("=== anchorage-str-db daily run: %s ===", scrape_date)

    con = store.connect(db_path)
    error_summary = None
    try:
        raw_results = airbnb_client.search_anchorage()
        parsed_by_id = {}
        for raw in raw_results:
            p = parse_listing(raw)
            if p is not None:
                parsed_by_id[p.listing_id] = p  # de-dupe: keep last occurrence
        parsed = list(parsed_by_id.values())
        log.info("parsed %d distinct listings (from %d raw results)", len(parsed), len(raw_results))

        # Pages are fetched *before* the merge, not after, so their fields
        # land in the same SCD2 version as the search fields they describe.
        pages = None
        page_stats = store.PageFetchStats()
        if fetch_pages:
            pages = listing_page.fetch_listing_pages([str(p.listing_id) for p in parsed])
            page_stats = store.PageFetchStats.of(pages)
            log.info(
                "listing pages: %d fetched, %d failed, %d with an exact location, "
                "%d with an STR registration number",
                page_stats.attempted,
                page_stats.failed,
                page_stats.exact_located,
                page_stats.registered,
            )

        listing_stats = store.merge_listings(con, scrape_date, parsed, pages=pages)
        store.insert_observations(con, scrape_date, parsed)
        retired = store.retire_stale_listings(con, scrape_date, config.RETIREMENT_GRACE_DAYS)

        room_ids = [str(p.listing_id) for p in parsed]
        calendar_results = airbnb_client.fetch_calendars(room_ids, min_date=scrape_date.isoformat())
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
                page_fetch_attempted=page_stats.attempted,
                page_fetch_failed=page_stats.failed,
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
                page_fetch_attempted=None,
                page_fetch_failed=None,
                error_summary=error_summary,
            ),
        )
        con.close()
        raise

    results = checks.run_checks(con, scrape_date, page_stats=page_stats if fetch_pages else None)
    ok = checks.report(results)
    con.close()

    if error_summary:
        ok = False
    log.info("=== run %s: %s ===", scrape_date, "PASSED" if ok else "FAILED")
    return ok
