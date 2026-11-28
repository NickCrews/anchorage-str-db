# Prices: the calendar has none, a stay quote does

Measured 2026-09-12 and 2026-09-13. Written for the former
`packages/airbnb-client/src/api/priceQuote.ts`. Airbnb's requests and parsing now live in [airbnb-dlp](https://github.com/NickCrews/airbnb-dlp).

**Summary:** Airbnb gives an unauthenticated caller no nightly price, only the
price of a specific stay. Each run prices one bookable stay per listing, for
one extra request per listing.

## The calendar has no prices

`PdpAvailabilityCalendar` responses for rooms 10403135 and 1975122 each have
365 days with these keys and no others:

```
__typename, available, availableForCheckin, availableForCheckout, bookable,
calendarDate, maxNights, minNights, price
```

On all 730 days `price` is:

```json
{ "__typename": "MerlinCalendarDayPrice", "localPriceFormatted": null }
```

Every calendar row in the archives through 2026-09-08 (270,546) also had a
NULL price.

The listing page renders no price either, with or without
`?check_in=…&check_out=…`: its booking sections' `structuredDisplayPrice` is
null. The browser fetches the price afterwards.

## A stay quote

That fetch is `StaysPdpBookItQuery` (GET), with the stay as
`dateRange: { startDate, endDate }` and the listing as a base64
`DemandStayListing:<id>`. The query rejects a request that leaves out any of
its variables. The response's `data.node.pdpPresentation.bookIt` holds
`structuredDisplayPrice` and `availability`. For room 1096318678417782390,
2027-01-12 to 01-19 (abridged):

```json
{
  "primaryLine": {
    "__typename": "OrderedDisplayPriceLine",
    "accessibilityLabel": "$1,126 for 7 nights, originally $1,611",
    "orderedComponents": [
      { "leadingContent": "From" },
      { "originalPrice": "$1,611" },
      { "discountedPrice": "$1,126" },
      { "qualifier": "for 7 nights" }
    ]
  },
  "explanationData": {
    "priceDetails": [
      { "items": [{ "description": "7 nights x $230.14", "priceString": "$1,611.00" }] }
    ]
  }
}
```

`primaryLine` takes three shapes: `OrderedDisplayPriceLine` as above,
`DiscountedDisplayPriceLine` with `discountedPrice` and `originalPrice` on the
line itself, and `QualifiedDisplayPriceLine` with `price`. For dates that
can't be booked, `structuredDisplayPrice` is null and
`availability.unavailabilityMessage` carries the reason, e.g. `"Those dates
are not available"`.

## Which stay

Only an open stay has a price, so the quote is for the earliest stay the
calendar says is bookable: a check-in night from tomorrow on with
`availableForCheckin`, `minNights` available nights, and a check-out day with
`availableForCheckout`.

On the 44-listing sample (2026-09-13): 44 calendars, 44 bookable stays, 44
quotes, all priced, none failed. Stays were 1 to 5 nights; check-in dates
ran from the next day to 8 months out. 44 quotes took 24 s at the run's shared
request rate.

## What is stored

On `airbnb_listing_observations`: `quote_check_in`, `quote_nights`, `quote_total`
(the displayed total after discounts), `quote_label` (the accessibility
label, or the unavailability message) and `quote_breakdown` (each
price-detail line as `description: priceString`).

The displayed total is rounded to the dollar: `$58 for 1 night` had the
breakdown `1 night x $57.06: $57.06`. Discounts appear as their own lines
(`Last-minute discount: -$82.50`, `Special offer: -$25.50`). No sampled
listing showed a cleaning or service fee line; one would appear in the
breakdown.

## Limits

- Booked nights, which revenue is made of, can't be priced. A night that is
  quoted while open and later booked has a price from before the booking.
- The quoted stay moves from day to day, so one listing's quotes are for
  different dates.
