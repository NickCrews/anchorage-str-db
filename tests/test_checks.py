from datetime import date, datetime

from anchorage_str_db import checks, config, store
from anchorage_str_db.airbnb_client import CalendarNight, CalendarResult


def _seed_minimal(con, scrape_date, make_listing):
    """Enough rows to make listing_count_plausible and freshness pass, so
    each test below only has to reason about the one check it's exercising."""
    lo, _ = config.PLAUSIBLE_LISTING_COUNT
    listings = [make_listing(i, f"Cabin {i}") for i in range(lo)]
    store.merge_listings(con, scrape_date, listings)
    store.insert_observations(con, scrape_date, listings)
    store.log_run(
        con,
        dict(
            scrape_date=scrape_date,
            run_started_at=datetime.combine(scrape_date, datetime.min.time()),
            run_finished_at=datetime.combine(scrape_date, datetime.min.time()),
            listings_seen=lo,
            listings_new=lo,
            listings_changed=lo,
            listings_retired=0,
            calendar_fetch_attempted=lo,
            calendar_fetch_failed=0,
            calendar_nights_changed=0,
            error_summary=None,
        ),
    )
    return listings


def test_no_backdated_calendar_rows_passes_on_clean_data(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)
    store.merge_calendar(
        con, d, [CalendarResult(room_id="0", nights=[CalendarNight("2026-08-18", True, 1, 100.0)])]
    )

    results = {r.name: r for r in checks.run_checks(con, d)}
    assert results["no_backdated_calendar_rows"].passed


def test_no_backdated_calendar_rows_catches_the_elapsed_month_artifact(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)
    # Simulate the bug directly (bypassing airbnb_client's min_date filter,
    # which is what actually prevents this): a night_date before valid_from.
    store.merge_calendar(
        con, d, [CalendarResult(room_id="0", nights=[CalendarNight("2026-08-01", False, 1, None)])]
    )

    results = {r.name: r for r in checks.run_checks(con, d)}
    check = results["no_backdated_calendar_rows"]
    assert not check.passed
    assert check.severity == "error"
    assert checks.report(list(results.values())) is False
