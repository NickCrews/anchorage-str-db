from datetime import date, datetime, timedelta

from anchorage_str_db import store
from anchorage_str_db.airbnb_client import CalendarNight, CalendarResult
from anchorage_str_db.listing_page import ListingPage


def test_connect_migrates_a_database_with_the_old_column_names(tmp_path):
    """The published database predates the location_* names: the daily job
    carries yesterday's file forward, so connect() must rename in place."""
    import duckdb

    path = tmp_path / "old.duckdb"
    old = duckdb.connect(str(path))
    old.execute(
        "CREATE TABLE listings (listing_id BIGINT, lat DOUBLE, lng DOUBLE, "
        "attr_hash VARCHAR, first_seen_date DATE, last_seen_date DATE, "
        "valid_from DATE, valid_to DATE, is_current BOOLEAN)"
    )
    old.execute(
        "INSERT INTO listings VALUES (1, 60.95, -149.1, 'h', DATE '2026-08-01', "
        "DATE '2026-08-01', DATE '2026-08-01', NULL, true)"
    )
    old.close()

    con = store.connect(path)

    assert con.execute(
        "SELECT location_lat, location_lng, location_is_exact, str_registration_id "
        "FROM listings"
    ).fetchall() == [(60.95, -149.1, None, None)]


def test_merge_listings_new_and_unchanged(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    day1 = [make_listing(1, "Cabin A"), make_listing(2, "Cabin B")]
    stats = store.merge_listings(con, date(2026, 8, 1), day1)
    assert stats == store.ListingMergeStats(seen=2, new=2, changed=2)

    # Re-merging the same attributes the next day should not open new versions.
    stats2 = store.merge_listings(con, date(2026, 8, 2), day1)
    assert stats2.new == 0
    assert stats2.changed == 0
    current = con.execute("SELECT count(*) FROM listings WHERE is_current").fetchone()[0]
    assert current == 2


def test_merge_listings_detects_attribute_change(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    store.merge_listings(con, date(2026, 8, 1), [make_listing(1, "Cabin A")])
    stats = store.merge_listings(con, date(2026, 8, 2), [make_listing(1, "Cabin A Renamed")])
    assert stats.changed == 1
    assert stats.new == 0

    rows = con.execute(
        "SELECT name, valid_from, valid_to, is_current FROM listings "
        "WHERE listing_id = 1 ORDER BY valid_from"
    ).fetchall()
    assert rows == [
        ("Cabin A", date(2026, 8, 1), date(2026, 8, 2), False),
        ("Cabin A Renamed", date(2026, 8, 2), None, True),
    ]


def test_retirement_has_grace_period(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    start = date(2026, 8, 1)
    grace = 5

    for i in range(3):
        d = start + timedelta(days=i)
        listings = [make_listing(1, "A"), make_listing(2, "B")]
        store.merge_listings(con, d, listings)
        store.retire_stale_listings(con, d, grace)

    # Listing 2 stops appearing from day 3 onward.
    retired_on = None
    for i in range(3, 3 + grace + 3):
        d = start + timedelta(days=i)
        store.merge_listings(con, d, [make_listing(1, "A")])
        n = store.retire_stale_listings(con, d, grace)
        if n and retired_on is None:
            retired_on = d

    # last_seen_date for listing 2 froze at start + 2 days (its last
    # appearance); retirement fires the first day the cutoff
    # (scrape_date - grace) strictly exceeds that, i.e. grace + 1 days later.
    assert retired_on == start + timedelta(days=2 + grace + 1)

    is_current = con.execute("SELECT is_current FROM listings WHERE listing_id = 2").fetchone()[0]
    assert is_current is False
    is_current_1 = con.execute("SELECT is_current FROM listings WHERE listing_id = 1").fetchone()[0]
    assert is_current_1 is True


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

    rows = con.execute(
        "SELECT available, valid_from, valid_to, is_current FROM calendar_status "
        "WHERE listing_id = 1 AND night_date = '2026-09-01' ORDER BY valid_from"
    ).fetchall()
    assert rows == [
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


def test_insert_observations_is_idempotent_per_day(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    listings = [make_listing(1, "A"), make_listing(2, "B")]
    store.insert_observations(con, date(2026, 8, 1), listings)
    store.insert_observations(con, date(2026, 8, 1), listings)  # re-run same day
    count = con.execute("SELECT count(*) FROM listing_observations").fetchone()[0]
    assert count == 2


def test_log_run_roundtrip(tmp_path):
    con = store.connect(tmp_path / "t.duckdb")
    store.log_run(
        con,
        dict(
            scrape_date=date(2026, 8, 1),
            run_started_at=datetime(2026, 8, 1, 6, 0),
            run_finished_at=datetime(2026, 8, 1, 6, 5),
            listings_seen=3,
            listings_new=3,
            listings_changed=3,
            listings_retired=0,
            calendar_fetch_attempted=3,
            calendar_fetch_failed=0,
            calendar_nights_changed=3,
            error_summary=None,
        ),
    )
    row = con.execute("SELECT listings_seen, error_summary FROM scrape_runs").fetchone()
    assert row == (3, None)


def test_listing_page_fields_merge_into_the_listing_row(make_listing):
    """They belong on the dimension, not in a side table — a query reading
    `location_lat` must be able to see `location_is_exact` without a join."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A"), make_listing(2, "Cabin B")]
    pages = [
        ListingPage(room_id="1", location_is_exact=True, str_registration_id="STR20260001",
                    location_source="json-ld+state"),
        ListingPage(room_id="2", location_is_exact=False, location_source="json-ld+state"),
    ]

    store.merge_listings(con, date(2026, 8, 26), parsed, pages=pages)

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
    store.merge_listings(con, date(2026, 8, 26), parsed,
                         pages=[ListingPage(room_id="1", location_is_exact=True,
                                            str_registration_id="STR20260001")])

    stats = store.merge_listings(con, date(2026, 8, 27), parsed)

    assert stats.changed == 0
    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 1
    assert con.execute(
        "SELECT location_is_exact, str_registration_id FROM listings WHERE is_current"
    ).fetchall() == [(True, "STR20260001")]


def test_a_failed_page_fetch_carries_forward_too(make_listing):
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    store.merge_listings(con, date(2026, 8, 26), parsed,
                         pages=[ListingPage(room_id="1", location_is_exact=True)])

    stats = store.merge_listings(con, date(2026, 8, 27), parsed,
                                 pages=[ListingPage(room_id="1", error="HTTPError: 429")])

    assert stats.changed == 0
    assert con.execute(
        "SELECT location_is_exact FROM listings WHERE is_current"
    ).fetchall() == [(True,)]


def test_re_running_pages_daily_does_not_open_a_new_version_each_day(make_listing):
    """page_seen_date is provenance, not an attribute — if it reached
    attr_hash this would grow a version per day, which is exactly the
    snapshot-per-day pattern the schema exists to avoid."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    page = ListingPage(room_id="1", location_is_exact=True, location_source="json-ld+state")
    store.merge_listings(con, date(2026, 8, 26), parsed, pages=[page])

    store.merge_listings(con, date(2026, 8, 27), parsed, pages=[page])
    store.merge_listings(con, date(2026, 8, 28), parsed, pages=[page])

    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 1
    # ...but the provenance still records that we looked today.
    assert con.execute("SELECT page_seen_date FROM listings").fetchall() == [(date(2026, 8, 28),)]


def test_a_host_publishing_their_registration_number_opens_a_new_version(make_listing):
    """The dated transition is the point: it's what lets the archive answer
    "when did hosts start complying with the display requirement?"."""
    con = store.connect(":memory:")
    parsed = [make_listing(1, "Cabin A")]
    store.merge_listings(con, date(2026, 8, 26), parsed,
                         pages=[ListingPage(room_id="1", location_is_exact=True)])

    stats = store.merge_listings(
        con, date(2026, 8, 27), parsed,
        pages=[ListingPage(room_id="1", location_is_exact=True, str_registration_id="STR20260001")],
    )

    assert stats.changed == 1
    assert con.execute(
        "SELECT str_registration_id, valid_from, valid_to, is_current FROM listings "
        "ORDER BY valid_from"
    ).fetchall() == [
        (None, date(2026, 8, 26), date(2026, 8, 27), False),
        ("STR20260001", date(2026, 8, 27), None, True),
    ]


def test_transaction_rolls_back_a_partial_run(tmp_path, make_listing):
    """A crash part-way through the writes must leave the day absent, not
    half-present. Without a transaction DuckDB autocommits each statement,
    so `merge_listings` alone would survive a later failure and the day
    would read as complete to every query."""
    con = store.connect(tmp_path / "t.duckdb")
    parsed = [make_listing(1, "Cabin A")]

    try:
        with store.transaction(con):
            store.merge_listings(con, date(2026, 8, 26), parsed)
            store.insert_observations(con, date(2026, 8, 26), parsed)
            raise RuntimeError("calendar merge blew up")
    except RuntimeError:
        pass

    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM listing_observations").fetchone()[0] == 0


def test_transaction_rollback_keeps_the_previous_version_current(tmp_path, make_listing):
    """The nastiest partial write `merge_listings` can leave behind: it
    closes a listing's current version and inserts the replacement as two
    separate statements, so a failure in between drops the listing out of
    `is_current` entirely — invisible to every check, since the listing
    count band is wide."""
    con = store.connect(tmp_path / "t.duckdb")
    with store.transaction(con):
        store.merge_listings(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])

    try:
        with store.transaction(con):
            store.merge_listings(con, date(2026, 8, 27), [make_listing(1, "Cabin A Renamed")])
            raise RuntimeError("died after opening the new version")
    except RuntimeError:
        pass

    rows = con.execute(
        "SELECT name, valid_to, is_current FROM listings WHERE listing_id = 1"
    ).fetchall()
    assert rows == [("Cabin A", None, True)]


def test_transaction_rolls_back_on_keyboard_interrupt(tmp_path, make_listing):
    """Ctrl-C is the realistic local failure, and KeyboardInterrupt is a
    BaseException — an `except Exception` would let it commit a partial day
    on the way out."""
    con = store.connect(tmp_path / "t.duckdb")
    try:
        with store.transaction(con):
            store.merge_listings(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])
            raise KeyboardInterrupt
    except KeyboardInterrupt:
        pass

    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 0


def test_transaction_commits_on_success(tmp_path, make_listing):
    con = store.connect(tmp_path / "t.duckdb")
    with store.transaction(con):
        store.merge_listings(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])
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
            store.merge_listings(con, date(2026, 8, 26), [make_listing(1, "Cabin A")])
            raise RuntimeError("boom")
    except RuntimeError:
        pass

    store.log_run(
        con,
        dict(
            scrape_date=date(2026, 8, 26),
            run_started_at=datetime(2026, 8, 26, 12, 0),
            run_finished_at=datetime(2026, 8, 26, 12, 5),
            listings_seen=None,
            listings_new=None,
            listings_changed=None,
            listings_retired=None,
            calendar_fetch_attempted=None,
            calendar_fetch_failed=None,
            calendar_nights_changed=None,
            error_summary="RuntimeError: boom",
        ),
    )

    assert con.execute("SELECT count(*) FROM listings").fetchone()[0] == 0
    assert con.execute(
        "SELECT error_summary, listings_seen FROM scrape_runs"
    ).fetchall() == [("RuntimeError: boom", None)]
