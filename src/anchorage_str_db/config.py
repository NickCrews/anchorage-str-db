"""Constants for the Anchorage STR scraper.

The bounding box is not eyeballed off a map — it's intended to cover the
Municipality of Anchorage footprint, including Anchorage Bowl and Girdwood.
Tune these bounds against fresh parcel extents from
https://github.com/NickCrews/anchorage-property as needed.

    duckdb -c "
      ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS parcels_db (READ_ONLY);
    SELECT min(centroid_lon), max(centroid_lon), min(centroid_lat), max(centroid_lat)
      FROM parcels_db.parcels_current;"
"""

from pathlib import Path

# The Municipality of Anchorage's real parcel extents, measured from the
# 98,550 parcels in anchorage-property with the query in the module
# docstring. `BBOX` must contain this with room to spare, and
# `tests/test_config.py` asserts that it does — the box is the scrape's
# entire definition of "Anchorage", so a box that clips is an undercount
# no downstream check can see.
MUNICIPALITY_EXTENT = {
    "sw_lat": 60.7837,
    "sw_long": -150.2417,
    "ne_lat": 61.4833,
    "ne_long": -148.8448,
}

# Municipality-wide Anchorage bounds, padded past MUNICIPALITY_EXTENT on
# every side. The previous box (60.86 / -150.35 / 61.47 / -148.85) was
# eyeballed and clipped 51 parcels off the south, north and east edges —
# small, but silently: listings outside the box are not "missing", they are
# never asked about.
BBOX = {
    "sw_lat": 60.77,
    "sw_long": -150.35,
    "ne_lat": 61.50,
    "ne_long": -148.80,
}

# Sent through to Airbnb's map search for realism, but it does not change
# what comes back: the same box returns an identical result set at zoom 11
# through 15 (measured). The bounding box alone selects the listings, which
# is why the result cap below is worked around by splitting the search and
# not by zooming in.
ZOOM_VALUE = 11

# Airbnb's search is only deterministic when the whole result set fits on
# one page.
#
# Two separate defects make a paginated search lie, and both are fixed by
# never paginating:
#
# 1. It stops at 280 items however many match, and says nothing: the last
#    page it will serve reports `nextPageCursor: null`, exactly like a
#    genuinely exhausted search. One Anchorage-wide query returned ~250
#    listings out of ~2600 and looked complete. (The limit is on items, not
#    pages — `itemsPerGrid=20` yields 14 pages, 40 yields 7.)
#
# 2. It re-ranks between page fetches, so the same listing lands on two
#    pages while another is skipped entirely. Churn measured against the
#    number of pages, three identical queries each:
#
#        1 page  ->  0 listings churned
#        3 pages -> 10-20 churned
#        5 pages -> 27-32 churned
#        7 pages -> 69 churned
#
# A single-page query has neither problem: nothing is truncated and there
# is no second page to shuffle against. Measured, a one-page query returns
# a byte-for-byte identical *set* on every repeat.
#
# So `search_anchorage` splits by price until every query fits one page,
# and then issues exactly one request per band. `pageCursors` in the
# response says how many pages exist, which makes "did this query tell me
# the truth?" a property we read rather than infer.
#
# The measurements behind all of this, and the alternatives that were tried
# and rejected (a stable sort key, larger pages, a map endpoint, text
# search), are in docs/research/airbnb-search-pagination.md. Read it before
# changing how the search is partitioned; otherwise it is not needed.
SEARCH_PAGE_SIZE = 40

# Price bands abut exactly — no overlap. `price_max=X` and `price_min=X`
# are complementary: measured on single-page queries, splitting a 26-listing
# box at $100/$125/$150/$200 gave below+above == 26 every time, with zero
# duplicates and zero gap.
#
# (An earlier version of this file overlapped the bands, on a measurement
# that showed two listings lost at a $150 split. That measurement was taken
# on a three-page query and was pagination churn, not a boundary gap.)
PRICE_BAND_SEEDS_USD = (
    (0, 75),
    (75, 100),
    (100, 125),
    (125, 150),
    (150, 200),
    (200, 300),
    (300, 500),
    (500, 1000),
    (1000, None),  # open-ended top band
)

# A band of this width cannot be split further. A $1 band that still needs
# more than one page would mean more than 40 listings at a single price,
# which price can no longer separate; `checks.search_single_page` fails the
# run rather than let the undercount pass as a complete scrape. Measured,
# the densest $1-2 bands in Anchorage (around the round numbers $150, $200)
# return 36 of a possible 40, so there is headroom but not a lot.
PRICE_BAND_MIN_WIDTH_USD = 1

# Same politeness budget as the other passes. Every band is exactly one
# request, so the request count is the band count: 181 for Anchorage,
# ~4 minutes end to end.
SEARCH_MIN_DELAY_S = 0.3
SEARCH_MAX_DELAY_S = 0.8

# Retries per search page, mirroring CALENDAR_MAX_RETRIES. Airbnb returns
# an occasional 500 that succeeds on the next attempt; observed killing a
# run mid-search. Unlike a failed calendar or page fetch, which costs one
# listing's detail, an unretried search failure aborts the whole pass and
# with it the day's run — so this pass is the one that can least afford to
# give up on the first error.
SEARCH_MAX_RETRIES = 4

# Coverage audit (see `airbnb_client.audit_coverage`). Price banding is
# only exhaustive if every listing carries a price Airbnb will filter on,
# and no amount of unit testing can confirm that against a live API. So
# each run re-searches a few small boxes around listings it already found,
# using a completely different query shape — a bbox with no price filter —
# and checks that everything those boxes return was in fact found. It is
# an independent second opinion, not a second enumeration: a handful of
# queries, not another full pass.
COVERAGE_AUDIT_SAMPLE = 6
COVERAGE_AUDIT_BOX_LAT = 0.010  # ~1.1 km
COVERAGE_AUDIT_BOX_LNG = 0.021  # ~1.1 km at 61N

# Fraction of audit-box listings the main pass may miss before the run
# fails.
#
# This check earned its keep: at 8% it caught Airbnb's unstable pagination
# dropping listings, which is why the search now splits to single-page
# queries instead of paginating. With that fixed the measured rate is 0%
# (4 usable boxes, 68 listings, 0 missed — 2 of the 6 sampled boxes needed
# more than one page and were skipped as untrustworthy).
#
# So the threshold is a tripwire rather than a tolerance. It is not zero
# only because the audit and the search ask in different shapes and Airbnb
# is not obliged to be perfectly consistent between them; anything
# approaching this number means the price bands have stopped covering the
# market.
MAX_COVERAGE_MISS_RATE = 0.05

CURRENCY = "USD"
LANGUAGE = "en"

# Be a polite scraper: cap concurrent calendar requests and pace them,
# rather than firing ~2600 requests at once. The delay is serial in the
# submit loop, so it, not the fetching, sets the pace of the whole pass.
# Measured per listing: 0.90s for a page, 0.82s for a calendar. At today's
# ~2600 listings that is ~40 minutes for the page pass and ~36 for the
# calendar pass, which with a ~4 minute search puts a full run around 80
# minutes. That is fine for a once-a-day job and deliberately unhurried,
# but these are the knobs to reach for if the run ever needs to be shorter
# — not the search, which is already 5% of the run and cannot be shrunk
# without losing listings again.
CALENDAR_CONCURRENCY = 4
CALENDAR_MIN_DELAY_S = 0.4
CALENDAR_MAX_DELAY_S = 1.2
CALENDAR_MAX_RETRIES = 3

DEFAULT_DB_PATH = Path("data/anchorage_str.duckdb")

# A listing absent from search results for this many consecutive days is
# considered delisted and its SCD2 version is closed. Longer than a couple
# of days on purpose: Airbnb's map search/pagination is occasionally flaky,
# and a listing blinking out for a day shouldn't read as "this STR closed."
RETIREMENT_GRACE_DAYS = 5

# Data-quality gate: a run is rejected if the listing count observed falls
# outside this band. A count outside it more likely reflects a broken bbox,
# a blocked scrape, or an Airbnb API change than a real market swing.
#
# The floor is deliberately well above the ~280 a single un-split query can
# return. The old floor of 200 let the search-cap bug (see
# SEARCH_PAGE_SIZE) pass the gate for its entire life: it reported 252
# listings against a true ~2600 and this check called that plausible.
# Widen the band as real history gives a better sense of natural variance.
PLAUSIBLE_LISTING_COUNT = (1000, 8000)

# A run's calendar-fetch failure rate above this fraction fails the
# data-quality gate — a few flaky requests are normal, a third of them
# failing usually means Airbnb rate-limited or blocked this run.
MAX_CALENDAR_FAILURE_RATE = 0.25

# Per-listing page (PDP) fetches, used by `listing_page.py` to read the
# location payload and STR registration number. Same politeness budget as
# the calendar pass, and deliberately a separate set of knobs: this is a
# full HTML page (~500 KB) per listing rather than a small JSON response,
# so it may need to be throttled independently if Airbnb starts objecting.
PAGE_CONCURRENCY = 4
PAGE_MIN_DELAY_S = 0.4
PAGE_MAX_DELAY_S = 1.2
PAGE_MAX_RETRIES = 3
PAGE_TIMEOUT_S = 30

# A listing-page pass with a failure rate above this fraction fails the
# data-quality gate, mirroring MAX_CALENDAR_FAILURE_RATE.
MAX_PAGE_FAILURE_RATE = 0.25
