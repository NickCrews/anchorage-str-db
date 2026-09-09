from datetime import date

import pytest

from anchorage_str_db import airbnb_client, config
from anchorage_str_db.airbnb_client import PriceBand


def test_fetch_one_calendar_drops_days_before_min_date(monkeypatch):
    """Regression test: Airbnb always returns the whole current month,
    including already-elapsed days marked available=false purely because
    the past can't be booked. Those must not be mistaken for real
    occupancy — see CONTRIBUTING.md."""

    def fake_get_calendar(api_key, room_id, proxy_url):
        # The run's key is threaded in rather than re-scraped per listing;
        # pyairbnb fetches its own when this is falsy, which is the thing
        # `get_api_key` exists to prevent.
        assert api_key == "RUNKEY"
        return [
            {
                "days": [
                    {"calendarDate": "2026-08-01", "available": False, "minNights": 2, "price": {}},
                    {"calendarDate": "2026-08-14", "available": False, "minNights": 2, "price": {}},
                    {"calendarDate": "2026-08-15", "available": True, "minNights": 2, "price": {}},
                    {"calendarDate": "2026-08-16", "available": False, "minNights": 2, "price": {}},
                ]
            }
        ]

    monkeypatch.setattr(airbnb_client.pyairbnb, "get_calendar", fake_get_calendar)

    result = airbnb_client._fetch_one_calendar(room_id="1", min_date="2026-08-15", api_key="RUNKEY")

    assert result.error is None
    assert [n.night_date for n in result.nights] == ["2026-08-15", "2026-08-16"]


# --------------------------------------------------------------------------
# Band arithmetic: the bands must tile [0, inf) with no gap, because a gap
# is exactly the failure this module exists to prevent — silently invisible
# listings, in a result that looks complete.
# --------------------------------------------------------------------------


def _covers(bands, price):
    return any(b.min_usd <= price and (b.max_usd is None or price <= b.max_usd) for b in bands)


def test_seed_bands_leave_no_gap_at_any_whole_dollar():
    bands = [PriceBand(lo, hi) for lo, hi in config.PRICE_BAND_SEEDS_USD]
    uncovered = [p for p in range(5000) if not _covers(bands, p)]
    assert uncovered == []


def test_splitting_a_band_covers_everything_the_parent_did():
    """`price_max=X` and `price_min=X` are complementary, so abutting halves
    lose nothing at the boundary. Measured on single-page queries: splitting
    a 26-listing box at $100/$125/$150/$200 gave below+above == 26 every
    time, with no duplicate and no gap."""
    parent = PriceBand(100, 200)
    halves = parent.split()
    for price in range(parent.min_usd, parent.max_usd + 1):
        assert _covers(halves, price), f"${price} fell between the halves"


def test_repeated_splitting_never_opens_a_gap():
    band = PriceBand(0, 1000)
    frontier = [band]
    for _ in range(6):
        nxt = []
        for b in frontier:
            nxt.extend(b.split() or [b])
        frontier = nxt
    uncovered = [p for p in range(1001) if not _covers(frontier, p)]
    assert uncovered == []


def test_splitting_the_open_top_band_stays_open_ended():
    halves = PriceBand(1000, None).split()
    assert halves[-1].max_usd is None
    for price in (1000, 1500, 2000, 10_000):
        assert _covers(halves, price)


def test_a_band_too_narrow_to_split_reports_none():
    assert PriceBand(100, 100 + config.PRICE_BAND_MIN_WIDTH_USD - 1).split() is None


# --------------------------------------------------------------------------
# Search recursion
# --------------------------------------------------------------------------


def _raw_page(next_cursor):
    return {
        "data": {
            "presentation": {
                "staysSearch": {"results": {"paginationInfo": {"nextPageCursor": next_cursor}}}
            }
        }
    }


# --------------------------------------------------------------------------
# Coverage audit — the check that we are finding all of the municipality,
# rather than merely finding a self-consistent subset of it.
# --------------------------------------------------------------------------


def _listing(room_id, lat=61.19, lng=-149.89):
    return {"room_id": room_id, "coordinates": {"latitude": lat, "longitud": lng}}


def test_audit_reports_zero_misses_when_the_bands_found_everything(monkeypatch):
    listings = [_listing(i) for i in range(20)]
    monkeypatch.setattr(airbnb_client, "get_api_key", lambda: "RUNKEY")
    monkeypatch.setattr(airbnb_client.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        airbnb_client,
        "_search_page",
        lambda api_key, band=None, box=None: ([_listing(1), _listing(2)], 1),
    )

    audit = airbnb_client.audit_coverage(listings, date(2026, 8, 18))

    assert audit.boxes == config.COVERAGE_AUDIT_SAMPLE
    assert audit.missed == 0
    assert audit.miss_rate == 0.0


def test_audit_catches_a_listing_the_price_bands_never_returned(monkeypatch):
    """The failure banding can have and geography cannot: a listing with no
    price Airbnb will filter on falls in no band, so it is absent from a
    result that looks completely healthy. Only a query with no price filter
    can see it."""
    listings = [_listing(i) for i in range(20)]
    monkeypatch.setattr(airbnb_client, "get_api_key", lambda: "RUNKEY")
    monkeypatch.setattr(airbnb_client.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        airbnb_client,
        "_search_page",
        lambda api_key, band=None, box=None: ([_listing(1), _listing(999_001)], 1),
    )

    audit = airbnb_client.audit_coverage(listings, date(2026, 8, 18))

    assert audit.missed_ids.count(999_001) == audit.boxes
    assert audit.miss_rate == 0.5


def test_audit_is_reproducible_for_a_date_but_moves_between_days(monkeypatch):
    listings = [_listing(i, lat=61.0 + i / 1000) for i in range(200)]
    boxes_seen = []
    monkeypatch.setattr(airbnb_client, "get_api_key", lambda: "RUNKEY")
    monkeypatch.setattr(airbnb_client.time, "sleep", lambda s: None)

    def record(api_key, band=None, box=None):
        boxes_seen.append(round(box["sw_lat"], 6))
        return [], 1

    monkeypatch.setattr(airbnb_client, "_search_page", record)

    airbnb_client.audit_coverage(listings, date(2026, 8, 18))
    first = list(boxes_seen)
    boxes_seen.clear()
    airbnb_client.audit_coverage(listings, date(2026, 8, 18))
    same_day = list(boxes_seen)
    boxes_seen.clear()
    airbnb_client.audit_coverage(listings, date(2026, 8, 19))
    next_day = list(boxes_seen)

    assert first == same_day
    assert first != next_day


def test_a_search_page_is_retried_past_a_transient_airbnb_500(monkeypatch):
    """Regression test: a single 500 from Airbnb aborted a whole run
    mid-search. A failed search page costs the entire pass — there is no
    partial search worth writing — so it must outlast a blip that the
    calendar and page passes could afford to drop one listing over."""
    attempts = {"n": 0}

    def flaky(*args, **kwargs):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("500 server error")
        return {"data": {"presentation": {"staysSearch": {"results": {}}}}}

    monkeypatch.setattr(airbnb_client.pyairbnb.search, "get", flaky)
    monkeypatch.setattr(
        airbnb_client.pyairbnb.standardize, "from_search", lambda raw: [{"room_id": 7}]
    )
    monkeypatch.setattr(airbnb_client.time, "sleep", lambda s: None)

    found, _ = airbnb_client._search_page("RUNKEY", PriceBand(0, 100))

    assert attempts["n"] == 3
    assert [r["room_id"] for r in found] == [7]


def test_a_search_page_that_never_recovers_raises_rather_than_returning_short(monkeypatch):
    """Giving up quietly would return a short page, which reads downstream
    as "these are all the listings in this band" — the exact silent
    undercount this module exists to prevent."""

    def always_fails(*args, **kwargs):
        raise RuntimeError("500 server error")

    monkeypatch.setattr(airbnb_client.pyairbnb.search, "get", always_fails)
    monkeypatch.setattr(airbnb_client.time, "sleep", lambda s: None)

    with pytest.raises(RuntimeError, match="after .* attempts"):
        airbnb_client._search_page("RUNKEY", PriceBand(0, 100))


# --------------------------------------------------------------------------
# Convergence: Airbnb's pagination re-ranks between page fetches, so one
# query returns duplicate slots and skips other listings entirely. The slot
# count is stable and is the population; the distinct count is the sample.
# --------------------------------------------------------------------------


def _raw_page(pages):
    """A response advertising `pages` pages in pageCursors."""
    return {
        "data": {
            "presentation": {
                "staysSearch": {"results": {"paginationInfo": {"pageCursors": ["c"] * pages}}}
            }
        }
    }


def test_search_page_issues_exactly_one_request_and_reports_the_page_count(monkeypatch):
    """The whole design rests on not paginating: a multi-page result set is
    both silently truncatable at 280 items and re-ranked between fetches."""
    calls = {"n": 0}

    def fake_get(api_key, cursor, *args, **kwargs):
        calls["n"] += 1
        assert cursor == "", "must never follow a cursor"
        return _raw_page(5)

    monkeypatch.setattr(airbnb_client.pyairbnb.search, "get", fake_get)
    monkeypatch.setattr(
        airbnb_client.pyairbnb.standardize, "from_search", lambda raw: [{"room_id": 1}]
    )

    rows, pages = airbnb_client._search_page("K", PriceBand(0, 100))

    assert calls["n"] == 1
    assert pages == 5
    assert [r["room_id"] for r in rows] == [1]


def _stub_pages(monkeypatch, by_band):
    """by_band maps (min, max) -> (rows, page_count)."""
    monkeypatch.setattr(airbnb_client, "get_api_key", lambda: "RUNKEY")
    monkeypatch.setattr(airbnb_client.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        airbnb_client,
        "_search_page",
        lambda api_key, band=None, box=None: by_band.get((band.min_usd, band.max_usd), ([], 1)),
    )


def test_a_single_page_band_is_accepted_as_complete(monkeypatch):
    seeds = config.PRICE_BAND_SEEDS_USD
    _stub_pages(monkeypatch, {seeds[0]: ([{"room_id": i} for i in range(10)], 1)})

    result = airbnb_client.search_anchorage()

    assert result.queries == len(seeds)
    assert len(result.listings) == 10
    assert result.unresolved == []


def test_a_multi_page_band_is_split_rather_than_paginated(monkeypatch):
    """Regression test for both Airbnb defects at once. Walking the pages of
    this band would return at most 280 of its listings, in a set that
    changes between identical calls; halving it until each half fits one
    page returns all of them, reproducibly."""
    seeds = config.PRICE_BAND_SEEDS_USD
    capped = seeds[0]
    halves = PriceBand(*capped).split()
    _stub_pages(
        monkeypatch,
        {
            capped: ([{"room_id": i} for i in range(40)], 7),
            (halves[0].min_usd, halves[0].max_usd): ([{"room_id": 1000 + i} for i in range(5)], 1),
            (halves[1].min_usd, halves[1].max_usd): ([{"room_id": 2000 + i} for i in range(7)], 1),
        },
    )

    result = airbnb_client.search_anchorage()

    # The parent's own page-1 sample is discarded in favour of the halves.
    assert sorted(r["room_id"] for r in result.listings) == (
        list(range(1000, 1005)) + list(range(2000, 2007))
    )
    assert result.unresolved == []


def test_a_band_that_cannot_be_narrowed_to_one_page_is_reported(monkeypatch):
    """More than a page of listings at a single price is something price can
    no longer separate. The query answering it is truncatable and unstable,
    and nothing in the data would show that, so it fails the run."""
    monkeypatch.setattr(config, "PRICE_BAND_SEEDS_USD", ((100, 101),))
    _stub_pages(monkeypatch, {(100, 101): ([{"room_id": i} for i in range(40)], 3)})

    result = airbnb_client.search_anchorage()

    assert result.unresolved == [PriceBand(100, 101)]


def test_audit_skips_a_box_that_needs_more_than_one_page(monkeypatch):
    """A multi-page audit box is unstable itself, so it cannot testify about
    what the search missed. Counting it would manufacture misses."""
    listings = [_listing(i) for i in range(20)]
    monkeypatch.setattr(airbnb_client, "get_api_key", lambda: "RUNKEY")
    monkeypatch.setattr(airbnb_client.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        airbnb_client, "_search_page", lambda api_key, band=None, box=None: ([_listing(9)], 4)
    )

    audit = airbnb_client.audit_coverage(listings, date(2026, 8, 18))

    assert audit.boxes == 0
    assert audit.missed == 0
