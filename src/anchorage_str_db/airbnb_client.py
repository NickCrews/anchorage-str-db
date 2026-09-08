"""Thin wrapper around pyairbnb: search Anchorage, fetch per-listing calendars.

pyairbnb (https://github.com/johnbalvin/pyairbnb) intercepts Airbnb's
internal StaysSearch / PdpAvailabilityCalendar GraphQL endpoints — the same
ones the website's map search and listing pages use — rather than scraping
rendered HTML. That makes it resilient to markup changes but means it's
riding on Airbnb's *unofficial* API surface, which can change without
notice; `get_api_key()`, `search_anchorage()` and `fetch_calendars()` are
the only calls into it, kept narrow on purpose so a breakage is easy to
localize.
"""

from __future__ import annotations

import logging
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

import pyairbnb

from anchorage_str_db import config

log = logging.getLogger(__name__)


def get_api_key() -> str:
    """Airbnb's public web API key, scraped from the homepage HTML.

    Fetched once per run and threaded through every calendar request.
    `pyairbnb.get_calendar` will happily fetch its own when not given one,
    but it does so *per call* — which meant every listing re-downloaded the
    same ~600 KB homepage to re-extract the same key, two thirds of the
    run's requests for one string. The key is a long-lived public constant,
    not a session token, so one fetch per run is plenty; if it ever does go
    stale mid-run every calendar fetch fails at once, which the run's
    calendar-failure-rate check already catches.
    """
    return pyairbnb.get_api_key("")


def search_anchorage() -> list[dict]:
    """One bbox search over Anchorage, paginated to completion by pyairbnb.

    No check-in/check-out dates are passed — an undated map search returns
    every listing Airbnb will show for the area, not just ones free on
    particular nights, which is what we want for "how many STRs exist."
    Nightly availability comes separately from each listing's calendar.
    """
    results = pyairbnb.search_all(
        check_in="",
        check_out="",
        ne_lat=config.BBOX["ne_lat"],
        ne_long=config.BBOX["ne_long"],
        sw_lat=config.BBOX["sw_lat"],
        sw_long=config.BBOX["sw_long"],
        zoom_value=config.ZOOM_VALUE,
        price_min=0,
        price_max=0,
        currency=config.CURRENCY,
        language=config.LANGUAGE,
        proxy_url="",
    )
    log.info("search_anchorage: %d raw results", len(results))
    return results


@dataclass
class CalendarNight:
    night_date: str  # ISO date
    available: bool
    min_nights: int | None
    price_amount: float | None


@dataclass
class CalendarResult:
    room_id: str
    nights: list[CalendarNight]
    error: str | None = None


def _fetch_one_calendar(room_id: str, min_date: str, api_key: str) -> CalendarResult:
    """`min_date` (ISO) drops already-elapsed days from Airbnb's response.

    Airbnb's calendar always returns the *whole* current month starting on
    the 1st, regardless of what day it actually is — so a scrape on the
    15th still gets calendarDate 1–14 back, marked `available: false`
    simply because the past can't be booked, not because anyone booked it.
    Left unfiltered, that reads as "100% occupied" for every day before the
    scrape ran, which is a UI artifact, not an occupancy signal.
    """
    last_err: Exception | None = None
    for attempt in range(1, config.CALENDAR_MAX_RETRIES + 1):
        try:
            months = pyairbnb.get_calendar(api_key=api_key, room_id=str(room_id), proxy_url="")
            nights = []
            for month in months:
                for day in month.get("days", []):
                    if day["calendarDate"] < min_date:
                        continue
                    price = day.get("price") or {}
                    amount = price.get("localPriceFormatted")
                    nights.append(
                        CalendarNight(
                            night_date=day["calendarDate"],
                            available=bool(day.get("available")),
                            min_nights=day.get("minNights"),
                            price_amount=_parse_price(amount),
                        )
                    )
            return CalendarResult(room_id=str(room_id), nights=nights)
        except Exception as e:  # noqa: BLE001 - want to retry any failure kind
            last_err = e
            if attempt < config.CALENDAR_MAX_RETRIES:
                time.sleep(0.5 * attempt)
    return CalendarResult(room_id=str(room_id), nights=[], error=str(last_err))


def _parse_price(formatted: str | None) -> float | None:
    """`localPriceFormatted` is a display string like "$269". Best-effort parse."""
    if not formatted:
        return None
    digits = "".join(c for c in formatted if c.isdigit() or c == ".")
    try:
        return float(digits) if digits else None
    except ValueError:
        return None


def fetch_calendars(room_ids: list[str], min_date: str) -> list[CalendarResult]:
    """Fetch every listing's calendar, capped concurrency, paced between requests.

    `min_date` (ISO, normally the run's scrape_date) drops elapsed days from
    each result — see `_fetch_one_calendar`.

    The API key is fetched once here and shared by every request in the pass;
    see `get_api_key` for why that isn't left to pyairbnb.

    Airbnb's calendar endpoint has no documented rate limit — CALENDAR_*
    settings in config.py are a conservative default, not a measured limit.
    """
    api_key = get_api_key()
    results: list[CalendarResult] = []
    with ThreadPoolExecutor(max_workers=config.CALENDAR_CONCURRENCY) as pool:
        futures = {}
        for room_id in room_ids:
            time.sleep(random.uniform(config.CALENDAR_MIN_DELAY_S, config.CALENDAR_MAX_DELAY_S))
            futures[pool.submit(_fetch_one_calendar, room_id, min_date, api_key)] = room_id
        for future in as_completed(futures):
            result = future.result()
            if result.error:
                log.warning("calendar fetch failed for room %s: %s", result.room_id, result.error)
            results.append(result)
    return results
