"""Parser tests for the listing page.

No network. These build pages shaped like Airbnb's and then deliberately
break them, because the point of `listing_page.py`'s layered design is what
it does when Airbnb changes something — a test suite that only checks the
happy path would pass right up until the parse started silently returning
nulls. What no offline test can tell you is whether Airbnb has *already*
changed; only a live fetch does that, which is what the
`extraction_layer_*_alive` data-quality checks are for.
"""

import json

import pytest

from anchorage_str_db.listing_page import parse_listing_page

STATE_LOCATION = {
    "__typename": "StaysPdpLocation",
    "subtitle": "Anchorage, Alaska, United States",
    "latitude": 60.9568,
    "longitude": -149.1294,
    "isExactLocation": True,
    "exactAddress": None,
    "verificationDetails": {"isVerified": True},
}


def make_page(
    state_location=STATE_LOCATION,
    json_ld=True,
    registration="STR20261897",
    description="A lovely cabin.",
    wrapper="niobeClientData",
    state=True,
):
    """A page shaped like Airbnb's: a schema.org block for search engines
    and a big GraphQL blob for the app, nested a few layers deep."""
    parts = []
    if json_ld:
        parts.append(
            '<script type="application/ld+json">'
            + json.dumps(
                {
                    "@context": "https://schema.org",
                    "@type": "VacationRental",
                    "latitude": 60.9568,
                    "longitude": -149.1294,
                    "address": {"addressLocality": "Anchorage"},
                }
            )
            + "</script>"
        )
    items = [{"title": "Other things to note", "html": {"htmlText": "no pets"}}]
    if registration:
        items.append({"title": "Registration Details", "html": {"htmlText": registration}})
    state_blob = {
        wrapper: [
            [
                "query",
                {
                    "data": {
                        "node": {
                            "pdpPresentation": {
                                "location": state_location,
                                "descriptions": {
                                    "longDescriptionHtml": {
                                        "localizedStringWithTranslationPreference": description
                                    }
                                },
                            }
                        },
                        "presentation": {
                            "stayProductDetailPage": {
                                "sections": {"sections": [{"section": {"items": items}}]}
                            }
                        },
                    }
                },
            ]
        ]
    }
    if state:
        parts.append(
            '<script id="data-deferred-state-0" type="application/json">'
            + json.dumps(state_blob)
            + "</script>"
        )
    return "<html><body>" + "".join(parts) + "</body></html>"


def test_reads_the_location_flag_and_coordinate():
    page = parse_listing_page(make_page(), room_id="1")

    assert page.location_is_exact is True
    assert (page.lat, page.lng) == (60.9568, -149.1294)
    assert page.location_subtitle == "Anchorage, Alaska, United States"
    assert page.location_verified is True
    assert page.str_registration_id == "STR20261897"
    assert page.location_source == "json-ld+state"


def test_fuzzed_listings_are_distinguishable_from_exact_ones():
    """The flag, not the coordinate, separates the two cases — Airbnb
    returns a plausible-looking Anchorage point either way."""
    fuzzed = dict(STATE_LOCATION, isExactLocation=False)

    page = parse_listing_page(make_page(state_location=fuzzed), room_id="1")

    assert page.location_is_exact is False


# --- resilience: the reason this parser is layered ------------------------


def test_survives_a_renamed_wrapper_because_lookup_is_by_shape():
    """A path-walking parser hardcoding `niobeClientData[0][1].data.node…`
    dies the day Airbnb renames any link in that chain."""
    page = parse_listing_page(make_page(wrapper="apolloState"), room_id="1")

    assert page.location_is_exact is True
    assert page.location_source == "json-ld+state"


def test_survives_a_renamed_flag():
    """`isExactLocation` -> `hasExactLocation`: matched on the key *pattern*."""
    renamed = {
        k.replace("isExactLocation", "hasExactLocation"): v for k, v in STATE_LOCATION.items()
    }

    page = parse_listing_page(make_page(state_location=renamed), room_id="1")

    assert page.location_is_exact is True


def test_falls_back_to_raw_html_when_the_json_will_not_parse():
    html = make_page().replace('type="application/json">', 'type="application/json">{{{')

    page = parse_listing_page(html, room_id="1")

    # The coordinate still comes from the intact schema.org block, and the
    # flag from a regex over the wreckage.
    assert (page.lat, page.location_is_exact) == (60.9568, True)
    assert page.location_source == "json-ld+raw-html"


def test_degrades_to_coordinate_only_when_the_state_blob_is_gone():
    """Losing the flag entirely has to be visible in the data, not just a
    log line — `location_source` is what the quality gate reads."""
    page = parse_listing_page(make_page(state=False), room_id="1")

    assert page.lat == 60.9568
    assert page.location_is_exact is None
    assert page.location_source == "json-ld"


def test_a_page_with_nothing_usable_raises_rather_than_returning_nulls():
    """A blocked or captcha'd fetch must surface as an error — a row of
    plausible nulls would be merged as though we'd looked and found nothing.
    """
    with pytest.raises(ValueError, match="no location data"):
        parse_listing_page("<html><body>Page not available</body></html>", "1")


# --- registration number --------------------------------------------------


def test_prefers_the_structured_registration_item_over_the_prose():
    page = parse_listing_page(
        make_page(registration="STR20261897", description="Permit STR20260000 " + "x" * 300),
        room_id="1",
    )

    assert page.str_registration_id == "STR20261897"


@pytest.mark.parametrize("text", ["STR20261897", "str 20261897", "STR-20261897", "Str20261897"])
def test_normalizes_the_case_and_separators_hosts_type_by_hand(text):
    page = parse_listing_page(make_page(registration=text), room_id="1")

    assert page.str_registration_id == "STR20261897"


def test_missing_registration_is_none_not_an_error():
    """Registration only became mandatory 2026-07-31; a listing without one
    is a finding, not a parse failure."""
    page = parse_listing_page(make_page(registration=None), room_id="1")

    assert page.str_registration_id is None
    assert page.location_is_exact is True


def test_refuses_to_guess_between_conflicting_registration_numbers():
    """The raw-html layer only answers when the page agrees with itself."""
    html = make_page(
        registration=None,
        description="Permit STR20260001 or maybe STR20260002. " + "Lovely cabin. " * 20,
    )

    page = parse_listing_page(html, room_id="1")

    assert page.str_registration_id is None
