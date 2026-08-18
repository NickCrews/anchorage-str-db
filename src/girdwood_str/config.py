"""Constants for the Girdwood STR scraper.

The bounding box is not eyeballed off a map — it's the min/max centroid of
every parcel the Municipality of Anchorage tags tax_district = '4' (the
Girdwood Valley Service Area), pulled from the public anchorage-property
lake (https://github.com/NickCrews/anchorage-property), padded by ~0.015
degrees (~1.5 km) so listings just outside the parcel extent (e.g. right on
the service-area edge) aren't clipped. Recomputing it:

    duckdb -c "
      ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS lake (READ_ONLY);
      SELECT min(centroid_lon), max(centroid_lon), min(centroid_lat), max(centroid_lat)
      FROM lake.parcels_current WHERE tax_district = '4';"
"""

from pathlib import Path

# Girdwood Valley Service Area, padded. See module docstring for provenance.
BBOX = {
    "sw_lat": 60.915,
    "sw_long": -149.195,
    "ne_lat": 61.005,
    "ne_long": -149.065,
}

# Airbnb's map search clusters pins at low zoom instead of returning every
# listing; 13 is close enough to street level that Girdwood (small) returns
# individual listings, not clusters, in one bbox.
ZOOM_VALUE = 13

CURRENCY = "USD"
LANGUAGE = "en"

# Be a polite scraper: cap concurrent calendar requests and pace them, rather
# than firing ~250 requests at once. At this rate a full run takes a few
# minutes, which is fine for a once-a-day job.
CALENDAR_CONCURRENCY = 4
CALENDAR_MIN_DELAY_S = 0.4
CALENDAR_MAX_DELAY_S = 1.2
CALENDAR_MAX_RETRIES = 3

DEFAULT_DB_PATH = Path("data/girdwood_str.duckdb")

# A listing absent from search results for this many consecutive days is
# considered delisted and its SCD2 version is closed. Longer than a couple
# of days on purpose: Airbnb's map search/pagination is occasionally flaky,
# and a listing blinking out for a day shouldn't read as "this STR closed."
RETIREMENT_GRACE_DAYS = 5

# Data-quality gate: a run is rejected if the listing count observed falls
# outside this band. Girdwood is small; anything outside this range more
# likely reflects a broken bbox, a blocked scrape, or an Airbnb API change
# than a real market swing. Widen it as the real history gives a better
# sense of natural variance.
PLAUSIBLE_LISTING_COUNT = (50, 800)

# A run's calendar-fetch failure rate above this fraction fails the
# data-quality gate — a few flaky requests are normal, a third of them
# failing usually means Airbnb rate-limited or blocked this run.
MAX_CALENDAR_FAILURE_RATE = 0.25
