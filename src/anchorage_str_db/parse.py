"""Turn a raw pyairbnb search-result dict into the flat fields we store.

Airbnb's search response doesn't have dedicated bedroom/bed/bathroom count
fields — they're only expressed as free-text lines like "1 bedroom", "4
beds", "1 bath" in `structuredContent.primaryLine`. This module regexes
those out rather than trusting the accompanying `type` tag (BEDINFO shows up
on both bedroom and bed lines in practice), which is a good deal more
robust to Airbnb wording changes.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

_COUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(bedroom|bed|bath|guest)s?\b", re.IGNORECASE)


@dataclass
class ParsedListing:
    listing_id: int
    name: str | None
    property_title: str | None
    bedrooms: int | None
    beds: int | None
    bathrooms: float | None
    guest_capacity: int | None
    lat: float | None
    lng: float | None
    url: str
    attr_hash: str
    rating_value: float | None
    review_count: int | None
    badges: list[str]
    price_hint_per_night: float | None
    price_qualifier: str | None


def _extract_counts(raw: dict) -> dict[str, float | int | None]:
    counts: dict[str, float] = {}
    lines = (raw.get("structuredContent") or {}).get("primaryLine") or []
    for line in lines:
        body = line.get("body") or ""
        m = _COUNT_RE.search(body)
        if m:
            counts[m.group(2).lower()] = float(m.group(1))
    return {
        # "bed" count only appears standalone on studios that have no
        # separate "bedroom" line; don't invent a bedroom count from it.
        "bedrooms": int(counts["bedroom"]) if "bedroom" in counts else None,
        "beds": int(counts["bed"]) if "bed" in counts else None,
        "bathrooms": counts.get("bath"),
        "guest_capacity": int(counts["guest"]) if "guest" in counts else None,
    }


def _extract_price_hint(raw: dict) -> tuple[float | None, str | None]:
    price = raw.get("price") or {}
    unit = price.get("unit") or {}
    qualifier = unit.get("qualifier")
    breakdown = price.get("break_down") or []
    if breakdown:
        # e.g. "5 nights x $285.29" -> 285.29
        m = re.search(r"x\s*\$?([\d,]+(?:\.\d+)?)", breakdown[0].get("description") or "")
        if m:
            return float(m.group(1).replace(",", "")), qualifier
    amount = unit.get("amount")
    return (float(amount) if amount else None), qualifier


def parse_listing(raw: dict) -> ParsedListing | None:
    room_id = raw.get("room_id")
    if room_id is None:
        return None

    coords = raw.get("coordinates") or {}
    lat = coords.get("latitude")
    # pyairbnb's own field name is misspelled "longitud" (no trailing e);
    # accept the correctly-spelled key too in case a future release fixes it.
    lng = coords.get("longitud", coords.get("longitude"))

    counts = _extract_counts(raw)
    price_hint, price_qualifier = _extract_price_hint(raw)
    rating = raw.get("rating") or {}
    review_count = rating.get("reviewCount")

    identity = (
        raw.get("name"),
        raw.get("title"),
        counts["bedrooms"],
        counts["beds"],
        counts["bathrooms"],
        counts["guest_capacity"],
        round(lat, 6) if lat is not None else None,
        round(lng, 6) if lng is not None else None,
        tuple(sorted(raw.get("badges") or [])),
    )
    attr_hash = hashlib.md5(repr(identity).encode()).hexdigest()

    return ParsedListing(
        listing_id=int(room_id),
        name=raw.get("name"),
        property_title=raw.get("title"),
        bedrooms=counts["bedrooms"],
        beds=counts["beds"],
        bathrooms=counts["bathrooms"],
        guest_capacity=counts["guest_capacity"],
        lat=lat,
        lng=lng,
        url=f"https://www.airbnb.com/rooms/{room_id}",
        attr_hash=attr_hash,
        rating_value=rating.get("value"),
        review_count=int(review_count) if review_count is not None else None,
        badges=list(raw.get("badges") or []),
        price_hint_per_night=price_hint,
        price_qualifier=price_qualifier,
    )
