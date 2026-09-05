"""Constants for the Anchorage STR scraper.

The bounding box is not eyeballed off a map — it's intended to cover the
Municipality of Anchorage footprint, including Anchorage Bowl and Girdwood.
Tune these bounds against fresh parcel extents from
https://github.com/NickCrews/anchorage-property as needed.

    duckdb -c "
      ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS lake (READ_ONLY);
    SELECT min(centroid_lon), max(centroid_lon), min(centroid_lat), max(centroid_lat)
    FROM lake.parcels_current;"
"""

from pathlib import Path

# Municipality-wide Anchorage bounds, padded. See module docstring for provenance.
BBOX = {
    "sw_lat": 60.86,
    "sw_long": -150.35,
    "ne_lat": 61.47,
    "ne_long": -148.85,
}

# Airbnb's map search clusters pins at low zoom instead of returning every
# listing; this lower zoom works better for a larger Anchorage-wide bbox.
ZOOM_VALUE = 11

CURRENCY = "USD"
LANGUAGE = "en"

# Be a polite scraper: cap concurrent calendar requests and pace them, rather
# than firing ~250 requests at once. At this rate a full run takes a few
# minutes, which is fine for a once-a-day job.
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
# outside this band. Anchorage is much larger than Girdwood, so this is
# intentionally broader.
# likely reflects a broken bbox, a blocked scrape, or an Airbnb API change
# than a real market swing. Widen it as the real history gives a better
# sense of natural variance.
PLAUSIBLE_LISTING_COUNT = (200, 6000)

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
