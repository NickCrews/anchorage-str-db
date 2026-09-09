"""The bounding box is the scrape's entire definition of "Anchorage".

Nothing downstream can tell a listing that does not exist from one the
search was never asked about, so the box's coverage of the municipality is
not something a data-quality check can verify after the fact — it has to be
asserted against an independent description of where Anchorage is.
"""

from anchorage_str_db import config


def test_bbox_contains_the_whole_municipality():
    """Regression test: the original box was eyeballed and clipped 51
    parcels off the south, north and east edges of the municipality."""
    bbox, muni = config.BBOX, config.MUNICIPALITY_EXTENT
    assert bbox["sw_lat"] < muni["sw_lat"], "box clips the south of the municipality"
    assert bbox["ne_lat"] > muni["ne_lat"], "box clips the north of the municipality"
    assert bbox["sw_long"] < muni["sw_long"], "box clips the west of the municipality"
    assert bbox["ne_long"] > muni["ne_long"], "box clips the east of the municipality"


def test_bbox_covers_girdwood():
    """Girdwood is ~40 miles from downtown but inside the municipality, and
    is dense with STRs. It sits far enough from the Bowl that a box drawn
    around the city proper misses it entirely."""
    girdwood_lat, girdwood_lng = 60.9584, -149.1178
    bbox = config.BBOX
    assert bbox["sw_lat"] <= girdwood_lat <= bbox["ne_lat"]
    assert bbox["sw_long"] <= girdwood_lng <= bbox["ne_long"]


def test_bbox_is_not_absurdly_larger_than_the_municipality():
    """Padding is deliberate, but a box several times too big wastes the
    search budget on the Chugach and Cook Inlet and would hide a mistake
    like swapped coordinates."""
    bbox, muni = config.BBOX, config.MUNICIPALITY_EXTENT
    bbox_area = (bbox["ne_lat"] - bbox["sw_lat"]) * (bbox["ne_long"] - bbox["sw_long"])
    muni_area = (muni["ne_lat"] - muni["sw_lat"]) * (muni["ne_long"] - muni["sw_long"])
    assert bbox_area < muni_area * 1.5
