from datetime import date, datetime, timedelta

import pytest

from anchorage_str_db import store
from anchorage_str_db.airbnb_client import CalendarNight, CalendarResult
from anchorage_str_db.listing_page import ListingPage


def _run_row(scrape_date, **overrides):
    row = dict(
        scrape_date=scrape_date,
        run_started_at=datetime.combine(scrape_date, datetime.min.time()),
        run_finished_at=datetime.combine(scrape_date, datetime.min.time()),
        listings_seen=1,
        listings_new=0,
        listings_changed=0,
        listings_retired=0,
        calendar_fetch_attempted=0,
        calendar_fetch_failed=0,
        calendar_nights_changed=0,
        error_summary=None,
    )
    row.update(overrides)
    return row


# --------------------------------------------------------------------------
# the derived dimension


def test_record_observations_new_and_unchanged(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    day1 = [make_listing(1, "Cabin A"), make_listing(2, "Cabin B")]
    stats = store.record_observations(con, date(2026, 8, 1), day1)
    assert stats == store.ObservationStats(seen=2, new=2, changed=2, retired=0)

    # Re-recording the same attributes the next day should not open new
    # versions, even though it writes two more observation rows.
    stats2 = store.record_observations(con, date(2026, 8, 2), day1)
    assert stats2.new == 0
    assert stats2.changed == 0
    assert con.execute("SELECT count(*) FROM listing_observations").fetchone()[0] == 4
    assert con.execute("SELECT count(*) FROM listings WHERE is_current").fetchone()[0] == 2


def test_record_observations_detects_attribute_change(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    store.record_observations(con, date(2026, 8, 1), [make_listing(1, "Cabin A")])
    stats = store.record_observations(con, date(2026, 8, 2), [make_listing(1, "Cabin A Renamed")])
    assert stats.changed == 1
    assert stats.new == 0

    assert con.execute(
        "SELECT name, valid_from, valid_to, is_current FROM listings "
        "WHERE listing_id = 1 ORDER BY valid_from"
    ).fetchall() == [
        ("Cabin A", date(2026, 8, 1), date(2026, 8, 2), False),
        ("Cabin A Renamed", date(2026, 8, 2), None, True),
    ]


def test_a_new_review_does_not_open_a_new_version(tmp_path, make_listing):
    """Rating and review count move most days. They belong to the day, not
    to the listing, which is why they are outside the version key — the old
    schema kept them in a separate table for the same reason."""
    con = store.connect(tmp_path / "t.duckdb")
    listing = make_listing(1, "Cabin A")
    store.record_observations(con, date(2026, 8, 1), [listing])

    busier = make_listing(1, "Cabin A")
    busier.review_count = 99
    busier.rating_value = 4.5
    busier.price_hint_per_night = 999.0
    stats = store.record_observations(con, date(2026, 8, 2), [busier])

    assert stats.changed == 0
    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 1
    # ...but the day's values are still recorded.
    assert con.execute(
        "SELECT review_count FROM listing_observations ORDER BY scrape_date"
    ).fetchall() == [(10,), (99,)]


def test_retirement_has_grace_period(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    start = date(2026, 8, 1)
    grace = 5

    for i in range(3):
        store.record_observations(
            con, start + timedelta(days=i), [make_listing(1, "A"), make_listing(2, "B")]
        )

    # Listing 2 stops appearing from day 3 onward.
    retired_on = None
    for i in range(3, 3 + grace + 3):
        d = start + timedelta(days=i)
        stats = store.record_observations(con, d, [make_listing(1, "A")])
        if stats.retired and retired_on is None:
            retired_on = d

    # Listing 2 was last seen on start + 2 days; retirement fires the first
    # day the cutoff (scrape_date - grace) strictly exceeds that, i.e.
    # grace + 1 days later.
    assert retired_on == start + timedelta(days=2 + grace + 1)

    assert con.execute(
        "SELECT listing_id, is_current FROM listings ORDER BY listing_id"
    ).fetchall() == [(1, True), (2, False)]


def test_a_run_that_sees_nothing_still_advances_the_retirement_clock(tmp_path, make_listing):
    """Retirement is measured back from the latest completed run, not from
    the latest observation. If it read the observations alone, the day every
    listing vanished would write no rows, freeze the clock, and leave the
    whole dead inventory reading as current indefinitely."""
    con = store.connect(tmp_path / "t.duckdb")
    start = date(2026, 8, 1)
    store.record_observations(con, start, [make_listing(1, "A")])
    store.log_run(con, _run_row(start))

    for i in range(1, 10):
        d = start + timedelta(days=i)
        store.record_observations(con, d, [])
        store.log_run(con, _run_row(d, listings_seen=0))

    assert con.execute("SELECT count(*) FROM listings WHERE is_current").fetchone()[0] == 0


def test_a_failed_run_does_not_advance_the_retirement_clock(tmp_path, make_listing):
    """A failed run logs a row with all counts NULL. Counting it as "the
    latest scrape" would retire the entire inventory on the strength of a
    run that never got as far as looking."""
    con = store.connect(tmp_path / "t.duckdb")
    store.record_observations(con, date(2026, 8, 1), [make_listing(1, "A")])
    store.log_run(
        con,
        _run_row(
            date(2026, 12, 1),
            listings_seen=None,
            listings_new=None,
            listings_changed=None,
            listings_retired=None,
            error_summary="HTTPError: 403",
        ),
    )

    assert con.execute("SELECT count(*) FROM listings WHERE is_current").fetchone()[0] == 1


def test_a_listing_that_comes_back_keeps_its_history(tmp_path, make_listing):
    """The failure the SCD2 table had: a listing retired and later relisted
    used to lose its true first_seen_date and have its registration number
    blanked, because the carry-forward join only looked at rows closed on
    the current scrape date and at `is_current` rows. Deriving from the
    observations, the gap is just a gap."""
    con = store.connect(tmp_path / "t.duckdb")
    page = ListingPage(room_id="1", location_is_exact=True, str_registration_id="STR20260001")
    store.record_observations(con, date(2026, 8, 1), [make_listing(1, "Cabin A")], pages=[page])

    for i in range(2, 12):  # gone long enough to be retired
        store.record_observations(con, date(2026, 8, i), [])
        store.log_run(con, _run_row(date(2026, 8, i), listings_seen=0))
    assert con.execute("SELECT count(*) FROM listings WHERE is_current").fetchone()[0] == 0

    store.record_observations(con, date(2026, 8, 20), [make_listing(1, "Cabin A")], pages=[page])

    assert con.execute(
        "SELECT first_seen_date, last_seen_date, str_registration_id, is_current "
        "FROM listings WHERE listing_id = 1"
    ).fetchall() == [(date(2026, 8, 1), date(2026, 8, 20), "STR20260001", True)]


# --------------------------------------------------------------------------
# listing-page fields


def test_listing_page_fields_land_on_the_listing_row(make_listing):
    """They belong on the dimension, not in a side table — a query reading
    `location_lat` must be able to see `location_is_exact` without a join."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A"), make_listing(2, "Cabin B")]
    pages = [
        ListingPage(room_id="1", location_is_exact=True, str_registration_id="STR20260001",
                    location_source="json-ld+state"),
        ListingPage(room_id="2", location_is_exact=False, location_source="json-ld+state"),
    ]

    store.record_observations(con, date(2026, 8, 26), parsed, pages=pages)

    assert con.execute(
        "SELECT listing_id, location_is_exact, str_registration_id, page_seen_date "
        "FROM listings WHERE is_current ORDER BY listing_id"
    ).fetchall() == [
        (1, True, "STR20260001", date(2026, 8, 26)),
        (2, False, None, date(2026, 8, 26)),
    ]


def test_a_run_without_pages_carries_forward_rather_than_blanking(make_listing):
    """"We didn't look today" must not read as "the host removed their
    registration number" — and must not open a spurious version."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    store.record_observations(con, date(2026, 8, 26), parsed,
                              pages=[ListingPage(room_id="1", location_is_exact=True,
                                                 str_registration_id="STR20260001")])

    stats = store.record_observations(con, date(2026, 8, 27), parsed)

    assert stats.changed == 0
    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 1
    assert con.execute(
        "SELECT location_is_exact, str_registration_id FROM listings WHERE is_current"
    ).fetchall() == [(True, "STR20260001")]


def test_a_failed_page_fetch_carries_forward_too(make_listing):
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    store.record_observations(con, date(2026, 8, 26), parsed,
                              pages=[ListingPage(room_id="1", location_is_exact=True)])

    stats = store.record_observations(con, date(2026, 8, 27), parsed,
                                      pages=[ListingPage(room_id="1", error="HTTPError: 429")])

    assert stats.changed == 0
    assert con.execute(
        "SELECT location_is_exact FROM listings WHERE is_current"
    ).fetchall() == [(True,)]
    # The row itself stays honest about not having looked; only the view
    # carries anything forward.
    assert con.execute(
        "SELECT page_fetch_ok, location_is_exact FROM listing_observations "
        "WHERE scrape_date = '2026-08-27'"
    ).fetchall() == [(False, None)]


def test_a_removed_registration_number_is_not_undone_by_a_later_failure(make_listing):
    """The distinction `page_fetch_ok` exists for. Once we have read a page
    and seen no number, a subsequent failed fetch must carry *that* forward
    — not resurrect the number from two days ago, which is what carrying
    each column forward on nullness alone would do."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    store.record_observations(con, date(2026, 8, 26), parsed,
                              pages=[ListingPage(room_id="1", location_is_exact=True,
                                                 str_registration_id="STR20260001")])
    # Read the page; the host has taken the number down.
    store.record_observations(con, date(2026, 8, 27), parsed,
                              pages=[ListingPage(room_id="1", location_is_exact=True)])
    # Now a failed fetch.
    store.record_observations(con, date(2026, 8, 28), parsed,
                              pages=[ListingPage(room_id="1", error="HTTPError: 429")])

    assert con.execute(
        "SELECT str_registration_id FROM listings WHERE is_current"
    ).fetchall() == [(None,)]
    assert con.execute(
        "SELECT valid_from, valid_to FROM listings ORDER BY valid_from"
    ).fetchall() == [
        (date(2026, 8, 26), date(2026, 8, 27)),
        (date(2026, 8, 27), None),
    ]


def test_re_reading_pages_daily_does_not_open_a_new_version_each_day(make_listing):
    """When we looked is provenance, not an attribute — if it were part of
    the version key this would grow a version per day."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    page = ListingPage(room_id="1", location_is_exact=True, location_source="json-ld+state")
    for day in (26, 27, 28):
        store.record_observations(con, date(2026, 8, day), parsed, pages=[page])

    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 1
    # ...but the provenance still records that we looked today.
    assert con.execute("SELECT page_seen_date FROM listings").fetchall() == [(date(2026, 8, 28),)]


def test_a_host_publishing_their_registration_number_opens_a_new_version(make_listing):
    """The dated transition is the point: it's what lets the archive answer
    "when did hosts start complying with the display requirement?"."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    store.record_observations(con, date(2026, 8, 26), parsed,
                              pages=[ListingPage(room_id="1", location_is_exact=True)])

    stats = store.record_observations(
        con, date(2026, 8, 27), parsed,
        pages=[ListingPage(room_id="1", location_is_exact=True,
                           str_registration_id="STR20260001")],
    )

    assert stats.changed == 1
    assert con.execute(
        "SELECT str_registration_id, valid_from, valid_to, is_current FROM listings "
        "ORDER BY valid_from"
    ).fetchall() == [
        (None, date(2026, 8, 26), date(2026, 8, 27), False),
        ("STR20260001", date(2026, 8, 27), None, True),
    ]


# --------------------------------------------------------------------------
# calendar


def test_merge_calendar_change_detection(tmp_path):
    con = store.connect(tmp_path / "t.duckdb")

    r1 = [CalendarResult(room_id="1", nights=[CalendarNight("2026-09-01", True, 2, 150.0)])]
    s1 = store.merge_calendar(con, date(2026, 8, 1), r1)
    assert s1.nights_changed == 1

    # Same value again: no new version.
    s_same = store.merge_calendar(con, date(2026, 8, 2), r1)
    assert s_same.nights_changed == 0

    # Flips to booked: new version, old one closed.
    r2 = [CalendarResult(room_id="1", nights=[CalendarNight("2026-09-01", False, 2, None)])]
    s2 = store.merge_calendar(con, date(2026, 8, 3), r2)
    assert s2.nights_changed == 1

    assert con.execute(
        "SELECT available, valid_from, valid_to, is_current FROM calendar_status "
        "WHERE listing_id = 1 AND night_date = '2026-09-01' ORDER BY valid_from"
    ).fetchall() == [
        (True, date(2026, 8, 1), date(2026, 8, 3), False),
        (False, date(2026, 8, 3), None, True),
    ]


def test_merge_calendar_failed_fetch_is_excluded(tmp_path):
    con = store.connect(tmp_path / "t.duckdb")
    results = [
        CalendarResult(room_id="1", nights=[CalendarNight("2026-09-01", True, 1, 100.0)]),
        CalendarResult(room_id="2", nights=[], error="timeout"),
    ]
    stats = store.merge_calendar(con, date(2026, 8, 1), results)
    assert stats.attempted == 2
    assert stats.failed == 1
    count = con.execute("SELECT count(*) FROM calendar_status WHERE listing_id = 2").fetchone()[0]
    assert count == 0


def test_calendar_current_drops_a_retired_listings_unconfirmed_future(tmp_path, make_listing):
    """When a listing is retired we stop fetching its calendar, so its
    forward nights freeze with is_current = true and would otherwise be
    counted as operating for up to twelve more months."""
    con = store.connect(tmp_path / "t.duckdb")
    start = date(2026, 8, 1)
    nights = [CalendarNight("2026-08-05", True, 2, 100.0), CalendarNight("2027-01-01", True, 2, 100.0)]
    store.record_observations(con, start, [make_listing(1, "A"), make_listing(2, "B")])
    store.merge_calendar(
        con, start, [CalendarResult(room_id=str(i), nights=nights) for i in (1, 2)]
    )

    # Listing 2 vanishes; listing 1 keeps being seen and keeps reporting.
    for i in range(1, 10):
        d = start + timedelta(days=i)
        store.record_observations(con, d, [make_listing(1, "A")])
        store.merge_calendar(con, d, [CalendarResult(room_id="1", nights=nights)])

    def operating(view, night):
        return con.execute(
            f"SELECT count(DISTINCT listing_id) FROM {view} "
            f"WHERE is_current AND night_date = '{night}'"
        ).fetchone()[0]

    assert operating("calendar_status", "2027-01-01") == 2  # the raw table still holds both
    assert operating("calendar_current", "2027-01-01") == 1  # only listing 1 is still live


def test_calendar_current_keeps_nights_a_retired_listing_really_operated(tmp_path, make_listing):
    """Realized occupancy for a listing that has since closed is genuine
    history — the cut is by night, not by listing, or every retirement would
    erase the months it was actually operating."""
    con = store.connect(tmp_path / "t.duckdb")
    start = date(2026, 8, 1)
    night = CalendarNight("2026-08-01", False, 2, 100.0)
    store.record_observations(con, start, [make_listing(1, "A"), make_listing(2, "B")])
    store.merge_calendar(
        con, start, [CalendarResult(room_id=str(i), nights=[night]) for i in (1, 2)]
    )
    for i in range(1, 10):
        store.record_observations(con, start + timedelta(days=i), [make_listing(1, "A")])

    assert con.execute("SELECT is_current FROM listings WHERE listing_id = 2").fetchone() == (False,)
    assert con.execute(
        "SELECT count(*) FROM calendar_current WHERE night_date = '2026-08-01'"
    ).fetchone()[0] == 2


# --------------------------------------------------------------------------
# schema, transactions, run log


def test_a_legacy_scd2_database_is_rejected(tmp_path):
    """There is no migration on purpose: the old table stored date
    *intervals*, so rebuilding daily rows from it would invent scrape dates
    for days that may have had no run."""
    import duckdb

    path = tmp_path / "legacy.duckdb"
    legacy = duckdb.connect(str(path))
    legacy.execute("CREATE TABLE listings (listing_id BIGINT, is_current BOOLEAN)")
    legacy.close()

    with pytest.raises(store.LegacySchemaError, match="pre-view schema"):
        store.connect(path)


def test_record_observations_is_idempotent_per_day(tmp_path, make_listing):
    """A run that fails the quality gate is expected to be re-run."""
    con = store.connect(tmp_path / "t.duckdb")
    listings = [make_listing(1, "A"), make_listing(2, "B")]
    stats = store.record_observations(con, date(2026, 8, 1), listings)
    again = store.record_observations(con, date(2026, 8, 1), listings)

    assert con.execute("SELECT count(*) FROM listing_observations").fetchone()[0] == 2
    assert again == stats  # including new=2: the re-run must not report them as known


def test_log_run_roundtrip(tmp_path):
    con = store.connect(tmp_path / "t.duckdb")
    store.log_run(con, _run_row(date(2026, 8, 1), listings_seen=3, listings_new=3))
    assert con.execute("SELECT listings_seen, error_summary FROM scrape_runs").fetchone() == (
        3,
        None,
    )


def test_transaction_rolls_back_a_partial_run(tmp_path, make_listing):
    """A crash part-way through the writes must leave the day absent, not
    half-present. Without a transaction DuckDB autocommits each statement,
    so the observations alone would survive a later failure and the day
    would read as complete to every query."""
    con = store.connect(tmp_path / "t.duckdb")
    parsed = [make_listing(1, "Cabin A")]

    try:
        with store.transaction(con):
            store.record_observations(con, date(2026, 8, 26), parsed)
            raise RuntimeError("calendar merge blew up")
    except RuntimeError:
        pass

    assert con.execute("SELECT count(*) FROM listing_observations").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 0


def test_transaction_rollback_keeps_the_previous_day_intact(tmp_path, make_listing):
    """Recording a day deletes its rows before inserting them, so a failure
    in between would drop the day entirely if it weren't transactional."""
    con = store.connect(tmp_path / "t.duckdb")
    with store.transaction(con):
        store.record_observations(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])

    try:
        with store.transaction(con):
            store.record_observations(con, date(2026, 8, 27), [make_listing(1, "Cabin A Renamed")])
            raise RuntimeError("died after writing the new day")
    except RuntimeError:
        pass

    assert con.execute(
        "SELECT name, valid_to, is_current FROM listings WHERE listing_id = 1"
    ).fetchall() == [("Cabin A", None, True)]


def test_transaction_rolls_back_on_keyboard_interrupt(tmp_path, make_listing):
    """Ctrl-C is the realistic local failure, and KeyboardInterrupt is a
    BaseException — an `except Exception` would let it commit a partial day
    on the way out."""
    con = store.connect(tmp_path / "t.duckdb")
    try:
        with store.transaction(con):
            store.record_observations(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])
            raise KeyboardInterrupt
    except KeyboardInterrupt:
        pass

    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 0


def test_transaction_commits_on_success(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    with store.transaction(con):
        store.record_observations(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])
    con.close()

    reopened = store.connect(tmp_path / "t.duckdb")
    assert reopened.execute("SELECT count(*) FROM listings WHERE is_current").fetchone()[0] == 1


def test_log_run_survives_a_rolled_back_transaction(tmp_path, make_listing):
    """The failed-run row is written after the rollback, on the same
    connection. If the pipeline wrote it *inside* the transaction, the record
    of the failure would roll back along with the run it records."""
    con = store.connect(tmp_path / "t.duckdb")
    try:
        with store.transaction(con):
            store.record_observations(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])
            raise RuntimeError("boom")
    except RuntimeError:
        pass

    store.log_run(
        con,
        _run_row(
            date(2026, 8, 26),
            listings_seen=None,
            listings_new=None,
            listings_changed=None,
            listings_retired=None,
            error_summary="RuntimeError: boom",
        ),
    )

    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 0
    assert con.execute("SELECT error_summary, listings_seen FROM scrape_runs").fetchall() == [
        ("RuntimeError: boom", None)
    ]
