"""The daily verb: search Anchorage, fetch every listing's calendar and its
own page, merge all three into the DuckDB store, log the run. One function,
`run_daily`, is the entire pipeline — and there is exactly one way to invoke
it, so the CLI, the tests, and GitHub Actions all produce the same run.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from pathlib import Path

from anchorage_str_db import airbnb_client, checks, listing_page, store
from anchorage_str_db.parse import parse_listing

log = logging.getLogger(__name__)


def run_daily(db_path: Path, scrape_date: date | None = None) -> bool:
    """Run one full daily scrape + merge + quality gate. Returns True iff it passed.

    Two phases, in this order and not interleaved: fetch everything, then
    write everything in one transaction. See `store.transaction` for why the
    writes are all-or-nothing, and the comments below for why the fetches
    stay outside.

    The fetching is three passes — the search, then each listing's own page,
    then each listing's calendar. The page pass is not optional. It adds a
    request per listing, but a run that skipped it would write rows whose
    `location_is_exact` and `str_registration_id` are carried-forward stale
    values rather than today's — a second, quieter kind of daily record that
    nothing downstream can distinguish from the real one. `page_fetch_ok`
    makes a skipped or failed page visible in the row itself, but a run that
    skipped the pass wholesale would still leave a day of them.
    """
    scrape_date = scrape_date or datetime.now(UTC).date()
    started = datetime.now(UTC)
    log.info("=== anchorage-str-db daily run: %s ===", scrape_date)

    con = store.connect(db_path)
    try:
        # ---- network phase -------------------------------------------------
        # Every fetch happens before any write. The passes are paced and take
        # minutes each, and they're where rate-limiting and blocking show up;
        # keeping them outside the transaction means a failure there costs
        # zero writes instead of leaving a half-written day behind.
        raw_results = airbnb_client.search_anchorage()
        parsed_by_id = {}
        for raw in raw_results:
            p = parse_listing(raw)
            if p is not None:
                parsed_by_id[p.listing_id] = p  # de-dupe: keep last occurrence
        parsed = list(parsed_by_id.values())
        log.info("parsed %d distinct listings (from %d raw results)", len(parsed), len(raw_results))

        room_ids = [str(p.listing_id) for p in parsed]

        pages = listing_page.fetch_listing_pages(room_ids)
        page_stats = store.PageFetchStats.of(pages)
        log.info(
            "listing pages: %d fetched, %d failed, %d with an exact location, "
            "%d with an STR registration number",
            page_stats.attempted,
            page_stats.failed,
            page_stats.exact_located,
            page_stats.registered,
        )

        calendar_results = airbnb_client.fetch_calendars(
            room_ids, min_date=scrape_date.isoformat()
        )

        # ---- write phase ---------------------------------------------------
        # Pages are recorded on the same row as the search fields they
        # describe, so a day is one row per listing and `listings` derives
        # its versions from that. Retirement needs no write at all — it is a
        # predicate on the observations, evaluated by the view.
        with store.transaction(con):
            listing_stats = store.record_observations(con, scrape_date, parsed, pages=pages)
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
                    listings_retired=listing_stats.retired,
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
        # Outside the transaction, which has already rolled back — otherwise
        # the record of the failure would roll back with the run it records.
        # The all-NULL counts are now literally true: nothing was written.
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

    # Reads committed data: the transaction closed above, so the gate judges
    # exactly what a later query would see.
    results = checks.run_checks(con, scrape_date, page_stats=page_stats)
    ok = checks.report(results)
    con.close()

    log.info("=== run %s: %s ===", scrape_date, "PASSED" if ok else "FAILED")
    return ok
