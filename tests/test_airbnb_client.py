from anchorage_str_db import airbnb_client


def test_fetch_one_calendar_drops_days_before_min_date(monkeypatch):
    """Regression test: Airbnb always returns the whole current month,
    including already-elapsed days marked available=false purely because
    the past can't be booked. Those must not be mistaken for real
    occupancy — see CONTRIBUTING.md."""

    def fake_get_calendar(room_id, proxy_url):
        return [
            {
                "days": [
                    {"calendarDate": "2026-08-01", "available": False, "minNights": 2, "price": {}},
                    {"calendarDate": "2026-08-14", "available": False, "minNights": 2, "price": {}},
                    {"calendarDate": "2026-08-15", "available": True, "minNights": 2, "price": {}},
                    {"calendarDate": "2026-08-16", "available": False, "minNights": 2, "price": {}},
                ]
            }
        ]

    monkeypatch.setattr(airbnb_client.pyairbnb, "get_calendar", fake_get_calendar)

    result = airbnb_client._fetch_one_calendar(room_id="1", min_date="2026-08-15")

    assert result.error is None
    assert [n.night_date for n in result.nights] == ["2026-08-15", "2026-08-16"]
