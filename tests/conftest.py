import pytest

from girdwood_str.parse import ParsedListing


@pytest.fixture
def make_listing():
    def _make(id, name, bedrooms=1, lat=60.95, badges=None):
        return ParsedListing(
            listing_id=id,
            name=name,
            property_title="Tiny home",
            bedrooms=bedrooms,
            beds=1,
            bathrooms=1.0,
            guest_capacity=2,
            lat=lat,
            lng=-149.1,
            url=f"https://airbnb.com/rooms/{id}",
            attr_hash=f"h-{name}-{bedrooms}-{lat}",
            rating_value=4.9,
            review_count=10,
            badges=badges or [],
            price_hint_per_night=150.0,
            price_qualifier="for 5 nights",
        )

    return _make
