from datetime import date, datetime

from anchorage_str_db import checks, config, store
from anchorage_str_db.airbnb_client import (
    CalendarNight,
    CalendarResult,
    CoverageAudit,
    PriceBand,
    SearchResult,
)


def _seed_minimal(con, scrape_date, make_listing):
    """Enough rows to make listing_count_plausible and freshness pass, so
    each test below only has to reason about the one check it's exercising."""
    lo, _ = config.PLAUSIBLE_LISTING_COUNT
    listings = [make_listing(i, f"Cabin {i}") for i in range(lo)]
    store.record_observations(con, scrape_date, listings)
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


def _run_checks(con, scrape_date, search_result=None, coverage=None):
    """Most tests here are about a database-derived check, so the in-memory
    pass summaries default to healthy ones."""
    return checks.run_checks(
        con,
        scrape_date,
        page_stats=store.PageFetchStats(),
        search_result=search_result or SearchResult(listings=[], queries=9),
        coverage=coverage or CoverageAudit(boxes=6, seen=100, missed_ids=[]),
    )


def test_no_backdated_calendar_rows_passes_on_clean_data(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)
    store.merge_calendar(
        con, d, [CalendarResult(room_id="0", nights=[CalendarNight("2026-08-18", True, 1, 100.0)])]
    )

    results = {r.name: r for r in _run_checks(con, d)}
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

    results = {r.name: r for r in _run_checks(con, d)}
    check = results["no_backdated_calendar_rows"]
    assert not check.passed
    assert check.severity == "error"
    assert checks.report(list(results.values())) is False


def test_search_coverage_passes_when_the_audit_found_nothing_missing(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)

    results = {r.name: r for r in _run_checks(con, d)}
    assert results["search_coverage"].passed


def test_search_coverage_fails_when_another_query_shape_finds_listings_we_missed(
    tmp_path, make_listing
):
    """The check that answers "are we finding all of the municipality?"
    rather than "is our own method internally consistent?". Price banding
    cannot see a listing with no filterable price; an unfiltered box can,
    and this is where that disagreement becomes a failed run."""
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)
    audit = CoverageAudit(boxes=6, seen=100, missed_ids=list(range(900_000, 900_020)))

    results = {r.name: r for r in _run_checks(con, d, coverage=audit)}
    check = results["search_coverage"]
    assert not check.passed
    assert check.severity == "error"
    assert "20/100" in check.detail
    assert checks.report(list(results.values())) is False


def test_search_coverage_tolerates_the_known_query_shape_difference(tmp_path, make_listing):
    """The measured miss rate with the convergence loop in place is 0%, but
    the audit and the search still ask in different shapes, so a listing or
    two of disagreement must not fail the run — otherwise the gate cries
    wolf and stops being read."""
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)
    audit = CoverageAudit(boxes=6, seen=100, missed_ids=list(range(900_000, 900_003)))

    results = {r.name: r for r in _run_checks(con, d, coverage=audit)}
    assert results["search_coverage"].passed


def test_search_coverage_warns_rather_than_silently_passing_when_it_did_not_run(
    tmp_path, make_listing
):
    """An audit that never ran must not read as an audit that found nothing."""
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)

    results = {r.name: r for r in _run_checks(con, d, coverage=CoverageAudit())}
    check = results["search_coverage"]
    assert not check.passed
    assert check.severity == "warn"
    # A warn must not fail the run on its own.
    assert checks.report(list(results.values())) is True


def test_search_single_page_passes_when_every_band_fit_one_page(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)

    results = {r.name: r for r in _run_checks(con, d)}
    assert results["search_single_page"].passed


def test_search_single_page_fails_when_a_band_needed_more_than_one_page(tmp_path, make_listing):
    """A multi-page query is silently truncatable at 280 items and returns a
    different set on every call. A band that could not be narrowed below one
    page was answered by such a query, and nothing in the resulting data
    would show it."""
    con = store.connect(tmp_path / "t.duckdb")
    d = date(2026, 8, 18)
    _seed_minimal(con, d, make_listing)
    stuck = PriceBand(150, 151)

    results = {
        r.name: r
        for r in _run_checks(con, d, SearchResult(listings=[], queries=40, unresolved=[stuck]))
    }
    check = results["search_single_page"]
    assert not check.passed
    assert check.severity == "error"
    assert str(stuck) in check.detail
    assert checks.report(list(results.values())) is False
