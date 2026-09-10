"""Thin wrapper around pyairbnb: search Anchorage, fetch per-listing calendars.

pyairbnb (https://github.com/johnbalvin/pyairbnb) intercepts Airbnb's
internal StaysSearch / PdpAvailabilityCalendar GraphQL endpoints — the same
ones the website's map search and listing pages use — rather than scraping
rendered HTML. That makes it resilient to markup changes but means it's
riding on Airbnb's *unofficial* API surface, which can change without
notice; `get_api_key()`, `search_anchorage()`, `audit_coverage()` and
`fetch_calendars()` are the only calls into it, kept narrow on purpose so a
breakage is easy to localize.

The search drives pyairbnb's pagination itself (`pyairbnb.search.get` plus
`standardize.from_search`) rather than calling `pyairbnb.search_all`, for
two reasons: `search_all` reports only a flat list, with no way to tell a
query that was truncated at the result cap from one that was genuinely
exhausted, and it paginates, which is the thing this module goes out of its
way not to do (see `_search_page`) — and it re-scrapes
an API key from Airbnb's ~600 KB homepage on every call, which at ~25
queries a run is the same waste `get_api_key` exists to avoid.
"""

from __future__ import annotations

import logging
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date

import pyairbnb

from anchorage_str_db import config, pace

log = logging.getLogger(__name__)


def get_api_key() -> str:
    """Airbnb's public web API key, scraped from the homepage HTML.

    Fetched once per pass and threaded through every request in it.
    `pyairbnb.get_calendar` will happily fetch its own when not given one,
    but it does so *per call* — which meant every listing re-downloaded the
    same ~600 KB homepage to re-extract the same key, two thirds of the
    run's requests for one string. The key is a long-lived public constant,
    not a session token, so one fetch per run is plenty; if it ever does go
    stale mid-run every calendar fetch fails at once, which the run's
    calendar-failure-rate check already catches.
    """
    pace.get().wait_turn()
    return pyairbnb.get_api_key("")


def _is_rate_limited(err: Exception) -> bool:
    """Did this failure come back 429?

    pyairbnb calls `raise_for_status()`, so a rate limit reaches us as an
    exception rather than a status code. curl_cffi formats it as
    "HTTP Error 429: " and attaches the response, so check the structured
    field first and fall back to the message.
    """
    response = getattr(err, "response", None)
    if response is not None and getattr(response, "status_code", None) == 429:
        return True
    return "429" in str(err)


@dataclass(frozen=True)
class PriceBand:
    """A `price_min`/`price_max` window, in whole USD. `max_usd is None` is
    the open-ended top band."""

    min_usd: int
    max_usd: int | None

    @property
    def width(self) -> float:
        return float("inf") if self.max_usd is None else self.max_usd - self.min_usd

    def split(self) -> list[PriceBand] | None:
        """Two abutting halves, or None if this band is one dollar wide.

        The halves share their boundary and that is correct, not a bug:
        `price_max=X` and `price_min=X` are complementary, so a listing
        priced exactly X lands in one half and only one. Measured on
        single-page (deterministic) queries, splitting a 26-listing box at
        $100, $125, $150 and $200 gave below+above == 26 every time, with
        no duplicates and nothing lost.
        """
        if self.max_usd is None:
            # Can't bisect an open interval; step the floor up instead.
            return [PriceBand(self.min_usd, self.min_usd * 2), PriceBand(self.min_usd * 2, None)]
        if self.width <= config.PRICE_BAND_MIN_WIDTH_USD:
            return None
        mid = (self.min_usd + self.max_usd) // 2
        return [PriceBand(self.min_usd, mid), PriceBand(mid, self.max_usd)]

    def __str__(self) -> str:
        return f"${self.min_usd}-{self.max_usd if self.max_usd is not None else 'inf'}"


@dataclass
class SearchResult:
    """One run's search pass.

    `unresolved` is what the quality gate cares about: bands that still
    needed more than one page at the narrowest width price can express. A
    multi-page query is both truncatable and non-deterministic, so those are
    listings we cannot vouch for."""

    listings: list[dict]
    queries: int = 0
    unresolved: list[PriceBand] = field(default_factory=list)


def _get_page(api_key: str, cursor: str, band: PriceBand | None, box: dict) -> dict:
    """One search page, retried past Airbnb's intermittent 5xx.

    A failed calendar or page fetch costs one listing's detail and is
    recorded as such; a failed search page costs the entire pass, and with
    it the run, because there is no partial search worth writing. So this
    retries where those give up, and only raises once Airbnb has refused
    `SEARCH_MAX_RETRIES` times in a row.
    """
    pacer = pace.get()
    last_err: Exception | None = None
    for attempt in range(1, config.SEARCH_MAX_RETRIES + 1):
        pacer.wait_turn()
        try:
            return pyairbnb.search.get(
                api_key,
                cursor,
                "",  # check_in
                "",  # check_out
                box["ne_lat"],
                box["ne_long"],
                box["sw_lat"],
                box["sw_long"],
                config.ZOOM_VALUE,
                config.CURRENCY,
                "",  # place_type
                band.min_usd if band else 0,
                (band.max_usd or 0) if band else 0,
                [],  # amenities
                False,  # free_cancellation
                0,  # adults
                0,  # children
                0,  # infants
                0,  # min_bedrooms
                0,  # min_beds
                0,  # min_bathrooms
                config.LANGUAGE,
                "",  # proxy_url
                "",  # hash
            )
        except Exception as e:  # noqa: BLE001 - want to retry any failure kind
            # A 429 is not a flaky 5xx and must not be retried: the block is
            # IP-wide and lasts on the order of an hour, so the retries only
            # deepen it. Fail the run now, with the real reason.
            if _is_rate_limited(e):
                pacer.note_rate_limited()
            if "timeout" in type(e).__name__.lower():
                pacer.note_timeout()
            last_err = e
            if attempt < config.SEARCH_MAX_RETRIES:
                log.warning("search page failed (attempt %d), retrying: %s", attempt, e)
                time.sleep(1.5 * attempt)
    raise RuntimeError(
        f"search page failed after {config.SEARCH_MAX_RETRIES} attempts"
    ) from last_err


def _search_page(
    api_key: str, band: PriceBand | None = None, box: dict | None = None
) -> tuple[list[dict], int]:
    """One request. Returns the rows and how many pages Airbnb says exist.

    Deliberately does not paginate. A result set that spans more than one
    page is both silently truncatable at 280 items and re-ranked between
    fetches, so the caller's job is to narrow the query until this returns a
    single page rather than to walk the pages of a lying one.

    No check-in/check-out dates are passed — an undated map search returns
    every listing Airbnb will show for the area, not just ones free on
    particular nights, which is what we want for "how many STRs exist."
    Nightly availability comes separately from each listing's calendar.
    """
    raw = _get_page(api_key, "", band, box or config.BBOX)
    rows = pyairbnb.standardize.from_search(raw)
    pagination = pyairbnb.utils.get_nested_value(
        raw, "data.presentation.staysSearch.results.paginationInfo", {}
    )
    return rows, len(pagination.get("pageCursors") or [])


def search_anchorage() -> SearchResult:
    """Search Anchorage as price bands narrow enough to each fit one page.

    Airbnb's paginated search cannot be trusted twice over: it stops at 280
    items without saying so, and it re-ranks between page fetches so that a
    listing can appear on two pages while another appears on none. Both
    defects live in pagination, and a query whose entire result set fits on
    one page has neither — measured, such a query returns an identical set
    on every repeat, while a seven-page query churns 69 listings between
    identical calls.

    So this never paginates. It asks for one page, and if Airbnb says more
    pages exist it halves the price band and asks again, until every query
    is answerable in a single page. `pageCursors` reports the page count in
    the same response, which makes completeness something the run reads off
    Airbnb rather than infers.

    The geographic footprint stays exactly `config.BBOX` throughout, which
    is what lets the scrape's scope be checked against the municipality's
    real parcel extents. Bands abut rather than overlap, so a listing is
    returned once; the pipeline de-dupes anyway.
    """
    api_key = get_api_key()
    result = SearchResult(listings=[])

    def visit(band: PriceBand) -> None:
        rows, pages = _search_page(api_key, band)
        result.queries += 1
        halves = band.split() if pages > 1 else None
        log.info(
            "search: %s -> %d results across %d page(s)%s",
            band,
            len(rows),
            pages,
            " (splitting)" if halves else "",
        )
        if halves:
            for half in halves:
                visit(half)
            return
        if pages > 1:
            log.warning(
                "search: %s still needs %d pages and is too narrow to split — "
                "more than %d listings at one price, which price cannot separate",
                band,
                pages,
                config.SEARCH_PAGE_SIZE,
            )
            result.unresolved.append(band)
        result.listings.extend(rows)

    for lo, hi in config.PRICE_BAND_SEEDS_USD:
        visit(PriceBand(lo, hi))

    log.info(
        "search_anchorage: %d results from %d single-page queries (%d unresolved)",
        len(result.listings),
        result.queries,
        len(result.unresolved),
    )
    return result


@dataclass
class CoverageAudit:
    """Result of re-asking for a sample of the market a different way.

    `missed` are listings an unfiltered box search returned that the price
    bands did not. See `audit_coverage`."""

    boxes: int = 0
    seen: int = 0
    missed_ids: list[int] = field(default_factory=list)

    @property
    def missed(self) -> int:
        return len(self.missed_ids)

    @property
    def miss_rate(self) -> float:
        return self.missed / self.seen if self.seen else 0.0


def audit_coverage(listings: list[dict], scrape_date: date) -> CoverageAudit:
    """Second-opinion check that the price bands actually covered the market.

    Banding is exhaustive only if every listing carries a price Airbnb will
    filter on. Nothing in the run can prove that from the inside: a band
    that silently omits the unpriced returns a tidy, plausible result and
    the union of tidy, plausible results looks complete. So this asks the
    same question in a shape that has no price filter at all — a handful of
    small bounding boxes drawn around listings we did find — and reports
    anything those boxes return that the bands did not.

    Boxes are centred on known listings rather than sampled uniformly over
    the bbox, because most of the bbox is mountain and would audit nothing.
    A box needing more than one page is skipped, not counted: a multi-page
    answer is both truncatable and unstable, so it cannot testify about what
    is missing.

    The sample is seeded by `scrape_date`, so a run is reproducible but
    successive days audit different neighbourhoods.
    """
    found_ids = {int(r["room_id"]) for r in listings if r.get("room_id") is not None}
    located = [r for r in listings if (r.get("coordinates") or {}).get("latitude") is not None]
    audit = CoverageAudit()
    if not located:
        return audit

    rng = random.Random(scrape_date.toordinal())
    api_key = get_api_key()
    for centre in rng.sample(located, min(config.COVERAGE_AUDIT_SAMPLE, len(located))):
        coords = centre["coordinates"]
        lat = coords["latitude"]
        lng = coords.get("longitud", coords.get("longitude"))
        if lng is None:
            continue
        box = {
            "sw_lat": lat - config.COVERAGE_AUDIT_BOX_LAT / 2,
            "ne_lat": lat + config.COVERAGE_AUDIT_BOX_LAT / 2,
            "sw_long": lng - config.COVERAGE_AUDIT_BOX_LNG / 2,
            "ne_long": lng + config.COVERAGE_AUDIT_BOX_LNG / 2,
        }
        rows, pages = _search_page(api_key, band=None, box=box)
        if pages > 1:
            log.info("coverage audit: box at %.4f,%.4f needs %d pages, skipping", lat, lng, pages)
            continue
        ids = {int(r["room_id"]) for r in rows if r.get("room_id") is not None}
        audit.boxes += 1
        audit.seen += len(ids)
        audit.missed_ids.extend(sorted(ids - found_ids))

    log.info(
        "coverage audit: %d boxes, %d listings seen, %d missed by the price bands (%.1f%%)",
        audit.boxes,
        audit.seen,
        audit.missed,
        audit.miss_rate * 100,
    )
    return audit


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
    pacer = pace.get()
    last_err: Exception | None = None
    for attempt in range(1, config.CALENDAR_MAX_RETRIES + 1):
        pacer.wait_turn()
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
            pacer.note_ok()
            return CalendarResult(room_id=str(room_id), nights=nights)
        except Exception as e:  # noqa: BLE001 - want to retry any failure kind
            if _is_rate_limited(e):
                pacer.note_rate_limited()  # raises RateLimited; aborts the run
            if "timeout" in type(e).__name__.lower():
                pacer.note_timeout()
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
        futures = {
            pool.submit(_fetch_one_calendar, room_id, min_date, api_key): room_id
            for room_id in room_ids
        }
        try:
            for future in as_completed(futures):
                result = future.result()
                if result.error:
                    log.warning(
                        "calendar fetch failed for room %s: %s", result.room_id, result.error
                    )
                results.append(result)
        except pace.RateLimited:
            for f in futures:
                f.cancel()
            raise
    return results
