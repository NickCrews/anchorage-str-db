"""Read a listing's own page for the two things search results don't carry:
whether its coordinate is real, and its municipal STR registration number.

## Why this module exists

Airbnb jitters the map pin for listings whose host hasn't opted into
showing the exact spot. The search endpoint gives us a `(lat, lng)` either
way and never says which case it is — but the listing page does, via an
`isExactLocation` boolean. Roughly half of Anchorage listings publish a
real coordinate; see `docs/research/airbnb-pdp-location-payload.md`.

The page also carries the Municipality of Anchorage STR registration
number (AO 2025-115(S-2), required in listings from 2026-07-31).

## Why it's built in layers

None of this is a documented API, so the parse is written as three
independent extraction layers, tried in order, rather than one path into
one blob. Each field takes the first layer that produces it, and every
layer that contributed is recorded in `location_source`, which the run's
data-quality gate reads (via `PageFetchStats`) so a silent degradation
fails the run instead of only leaving a log line:

1. **`json-ld`** — the schema.org `VacationRental` block Airbnb publishes
   for Google rich results. A public standard, load-bearing for their SEO,
   and by far the least likely thing on the page to change shape. Carries
   the coordinate, but not `isExactLocation`.
2. **`state`** — the server-rendered GraphQL response embedded in a
   `<script type="application/json">`. This has every field, and is the
   only source for `isExactLocation`. Located by *shape* — we search every
   JSON script for an object that has a boolean key matching
   `exact…location` — rather than by walking a hardcoded path like
   `niobeClientData[0][1].data.node.pdpPresentation.location`, so a
   reshuffle of the surrounding structure (or a renamed script id, or a
   renamed wrapper) doesn't break it. Only renaming the leaf fields does.
3. **`raw-html`** — regexes over the undecoded document. Survives the JSON
   failing to parse at all. Deliberately refuses to guess: if a pattern
   matches more than one distinct value anywhere in the page, it returns
   nothing rather than picking one.

`pyairbnb.get_details()` fetches this same page, but its standardizer
(`standardize.from_details`) keeps only the prose location blurbs and
drops the coordinate object entirely, so there's nothing to reuse.
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, fields

from bs4 import BeautifulSoup
from curl_cffi import requests

from anchorage_str_db import config

log = logging.getLogger(__name__)

# Matched against *key names* in the embedded JSON, not against a fixed
# path — survives isExactLocation -> hasExactLocation and friends.
_EXACT_LOCATION_KEY_RE = re.compile(r"exact.*location", re.IGNORECASE)
_LAT_KEY_RE = re.compile(r"^lat(itude)?$", re.IGNORECASE)
_LNG_KEY_RE = re.compile(r"^(lng|long|longitude|longitud)$", re.IGNORECASE)
_ADDRESS_KEY_RE = re.compile(r"^exact.*address$", re.IGNORECASE)

# Anchorage-issued STR numbers look like "STR20261897". Hosts type them by
# hand into a free-text field, so accept lowercase and a stray separator.
_STR_NUMBER_RE = re.compile(r"\bSTR[\s\-]?(\d{6,})\b", re.IGNORECASE)
_REGISTRATION_TITLE_RE = re.compile(r"registration", re.IGNORECASE)

_RAW_FLAG_RE = re.compile(r'"\w*[eE]xact[lL]ocation\w*"\s*:\s*(true|false)')

_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": config.LANGUAGE,
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}


@dataclass
class ListingPage:
    """What one listing's page told us. Every field is optional: a layer
    that can't find something leaves it None rather than guessing, and
    `location_source` records which layers actually contributed."""

    room_id: str
    lat: float | None = None
    lng: float | None = None
    # Airbnb's own flag (`isExactLocation`) for whether `lat`/`lng` is the
    # listing's true position or the obfuscated pin. The reason this module
    # exists.
    location_is_exact: bool | None = None
    # Populated only for listings publishing a street address outright;
    # null on most listings measured so far, but cheap to carry.
    location_exact_address: str | None = None
    location_subtitle: str | None = None
    location_verified: bool | None = None
    str_registration_id: str | None = None
    # Which extraction layers contributed, e.g. "json-ld+state". Provenance
    # about the parse, not the listing: it feeds logs and the run's
    # PageFetchStats, and is not persisted to the database.
    location_source: str | None = None
    error: str | None = None


# --------------------------------------------------------------------------
# tree walking


def _iter_objects(node) -> Iterator[dict]:
    """Every dict anywhere in a decoded JSON document, depth-first."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _iter_objects(value)
    elif isinstance(node, list):
        for value in node:
            yield from _iter_objects(value)


def _first_key(obj: dict, pattern: re.Pattern, of_type: type | tuple[type, ...]):
    """The value of the first key matching `pattern` that holds `of_type`.

    Type-checking the value matters as much as matching the key: an object
    can carry both a `latitude` float and a `latitudeDelta`, and `bool` is
    a subclass of `int`, so a numeric lookup has to reject booleans
    explicitly or `isExactLocation` would answer a request for a
    coordinate.
    """
    for key, value in obj.items():
        if not pattern.search(key):
            continue
        if of_type is bool:
            if isinstance(value, bool):
                return value
        elif isinstance(value, of_type) and not isinstance(value, bool):
            return value
    return None


def _json_scripts(soup: BeautifulSoup) -> Iterator[dict | list]:
    """Every parseable JSON `<script>`, biggest first.

    Not selecting `#data-deferred-state-0` by id on purpose — the id is an
    implementation detail of Airbnb's renderer. The payload we want is
    always the largest JSON blob on the page, so trying them in size order
    finds it first without naming it.
    """
    scripts = [
        script
        for script in soup.find_all("script")
        # By declared type, or — if Airbnb drops the attribute — by the
        # content simply looking like a JSON document.
        if "json" in (script.get("type") or "") or script.get_text().lstrip()[:1] == "{"
    ]
    for script in sorted(scripts, key=lambda s: len(s.get_text()), reverse=True):
        try:
            yield json.loads(script.get_text())
        except (ValueError, TypeError):
            continue


# --------------------------------------------------------------------------
# layer 1: schema.org JSON-LD


def _from_json_ld(soup: BeautifulSoup) -> dict:
    """The `VacationRental` block Airbnb publishes for search engines."""
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            doc = json.loads(script.get_text())
        except (ValueError, TypeError):
            continue
        for obj in _iter_objects(doc):
            if "latitude" not in obj or "longitude" not in obj:
                continue
            # Only the coordinate. JSON-LD's `addressLocality` is a bare
            # town name where `location_subtitle` is a full "Anchorage,
            # Alaska, United States" — taking it here would silently change
            # what that column means depending on which layer won.
            return {"lat": float(obj["latitude"]), "lng": float(obj["longitude"])}
    return {}


# --------------------------------------------------------------------------
# layer 2: the embedded GraphQL state, located by shape


def _find_registration(doc) -> str | None:
    """The number appears twice: as a titled list item (clean — the value is
    the whole string) and inlined at the end of the long description. Prefer
    the titled item, fall back to any long text that mentions one."""
    prose: set[str] = set()
    for obj in _iter_objects(doc):
        title = obj.get("title")
        if isinstance(title, str) and _REGISTRATION_TITLE_RE.search(title):
            # A field Airbnb itself labels "Registration…" is authoritative.
            for value in _iter_objects(obj):
                for text in value.values():
                    if isinstance(text, str) and (m := _STR_NUMBER_RE.search(text)):
                        return f"STR{m.group(1)}"
        for value in obj.values():
            if isinstance(value, str) and len(value) > 200:
                prose.update(m.group(1) for m in _STR_NUMBER_RE.finditer(value))
    # Unlabelled prose only counts if it says one thing. A description
    # naming two different numbers (a host who manages several units, say)
    # is ambiguous, and picking the first would be a coin flip recorded as
    # a fact — the same rule `_sole_match` applies to the raw-html layer.
    return f"STR{prose.pop()}" if len(prose) == 1 else None


def _from_embedded_state(soup: BeautifulSoup) -> dict:
    """Accumulate across every JSON script rather than committing to one.

    The location object and the registration item live in the same blob
    today, but nothing guarantees they always will, so each is taken from
    whichever script has it.
    """
    found: dict = {}
    for doc in _json_scripts(soup):
        if "location_is_exact" not in found:
            found.update(_location_from(doc))
        if "str_registration_id" not in found:
            registration = _find_registration(doc)
            if registration:
                found["str_registration_id"] = registration
    return found


def _location_from(doc) -> dict:
    for obj in _iter_objects(doc):
        flag = _first_key(obj, _EXACT_LOCATION_KEY_RE, bool)
        if flag is None:
            continue
        # Whatever this object is called now, it's the location object.
        verification = obj.get("verificationDetails")
        found = {
            "location_is_exact": flag,
            "lat": _first_key(obj, _LAT_KEY_RE, (int, float)),
            "lng": _first_key(obj, _LNG_KEY_RE, (int, float)),
            "location_exact_address": _first_key(obj, _ADDRESS_KEY_RE, str),
            "location_subtitle": obj.get("subtitle"),
            "location_verified": (
                verification.get("isVerified") if isinstance(verification, dict) else None
            ),
        }
        return {k: v for k, v in found.items() if v is not None}
    return {}


# --------------------------------------------------------------------------
# layer 3: regex over the undecoded document


def _sole_match(pattern: re.Pattern, html: str) -> str | None:
    """A value only if the page agrees with itself about it.

    Every one of these patterns can in principle match something unrelated.
    Rather than take the first hit, take the hit only when the whole
    document yields exactly one distinct value — otherwise we'd be
    inventing a coordinate or a permit number out of a coincidence.
    """
    values = {m.group(1) for m in pattern.finditer(html)}
    return values.pop() if len(values) == 1 else None


def _from_raw_html(html: str) -> dict:
    found: dict = {}
    flag = _sole_match(_RAW_FLAG_RE, html)
    if flag is not None:
        found["location_is_exact"] = flag == "true"
    number = _sole_match(_STR_NUMBER_RE, html)
    if number is not None:
        found["str_registration_id"] = f"STR{number}"
    return found


# --------------------------------------------------------------------------


_LAYERS = ("json-ld", "state", "raw-html")


def parse_listing_page(html: str, room_id: str) -> ListingPage:
    """Extract what we can, recording which layers it came from.

    Raises only if *no* layer produced anything — that means a blocked,
    redirected, or captcha'd fetch, which must surface as an error rather
    than as a row of plausible-looking nulls.
    """
    soup = BeautifulSoup(html, "html.parser")
    by_layer = {
        "json-ld": _from_json_ld(soup),
        "state": _from_embedded_state(soup),
        "raw-html": _from_raw_html(html),
    }

    page = ListingPage(room_id=str(room_id))
    contributors: list[str] = []
    known = {f.name for f in fields(ListingPage)}
    for layer in _LAYERS:
        used = False
        for key, value in by_layer[layer].items():
            if key in known and getattr(page, key) is None and value is not None:
                setattr(page, key, value)
                used = True
        if used:
            contributors.append(layer)

    if not contributors:
        raise ValueError(f"no location data in the page for room {room_id}")

    _warn_on_disagreement(by_layer, room_id)
    page.location_source = "+".join(contributors)
    return page


def _warn_on_disagreement(by_layer: dict[str, dict], room_id: str) -> None:
    """Layers reading different parts of the page should agree. If they
    don't, one of them has started matching the wrong thing — which is
    exactly the failure mode a single-path parser hides."""
    for key in ("lat", "lng", "location_is_exact", "str_registration_id"):
        values = {
            layer: found[key] for layer, found in by_layer.items() if found.get(key) is not None
        }
        distinct = {round(v, 5) if isinstance(v, float) else v for v in values.values()}
        if len(distinct) > 1:
            log.warning("room %s: layers disagree on %s: %s", room_id, key, values)


def _fetch_one_page(room_id: str) -> ListingPage:
    last_err: Exception | None = None
    for attempt in range(1, config.PAGE_MAX_RETRIES + 1):
        try:
            response = requests.get(
                f"https://www.airbnb.com/rooms/{room_id}",
                headers=_HEADERS,
                timeout=config.PAGE_TIMEOUT_S,
                impersonate="chrome",
            )
            response.raise_for_status()
            return parse_listing_page(response.text, room_id)
        except Exception as e:  # noqa: BLE001 - retry any failure kind, as with calendars
            last_err = e
            if attempt < config.PAGE_MAX_RETRIES:
                time.sleep(0.5 * attempt)
    return ListingPage(room_id=str(room_id), error=str(last_err))


def fetch_listing_pages(room_ids: list[str]) -> list[ListingPage]:
    """Fetch every listing's page, capped concurrency, paced between requests.

    Same politeness budget as `airbnb_client.fetch_calendars` — this is a
    second full pass over every listing, so a run that does both makes
    roughly twice the requests it used to.
    """
    results: list[ListingPage] = []
    with ThreadPoolExecutor(max_workers=config.PAGE_CONCURRENCY) as pool:
        futures = {}
        for room_id in room_ids:
            time.sleep(random.uniform(config.PAGE_MIN_DELAY_S, config.PAGE_MAX_DELAY_S))
            futures[pool.submit(_fetch_one_page, room_id)] = room_id
        for future in as_completed(futures):
            result = future.result()
            if result.error:
                log.warning(
                    "listing page fetch failed for room %s: %s", result.room_id, result.error
                )
            results.append(result)
    return results
