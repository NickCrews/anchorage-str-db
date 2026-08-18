from datetime import date, datetime, timedelta

from girdwood_str import store
from girdwood_str.airbnb_client import CalendarNight, CalendarResult
from girdwood_str.parse import ParsedListing


def make_listing(id, name, bedrooms=1, lat=60.95, badges=None):
    return ParsedListing(
        listing_id=id,
        name=name,
        property_title="Tiny home",
        bedrooms=bedrooms,
        beds=1,
        bathrooms=1.0,
        guest_capacity=2,
        lat=lat,
        lng=-149.1,
        url=f"https://airbnb.com/rooms/{id}",
        attr_hash=f"h-{name}-{bedrooms}-{lat}",
        rating_value=4.9,
        review_count=10,
        badges=badges or [],
        price_hint_per_night=150.0,
        price_qualifier="for 5 nights",
    )


def test_merge_listings_new_and_unchanged(tmp_path):
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


def test_merge_listings_detects_attribute_change(tmp_path):
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


def test_retirement_has_grace_period(tmp_path):
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


def test_insert_observations_is_idempotent_per_day(tmp_path):
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
