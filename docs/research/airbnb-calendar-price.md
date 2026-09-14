# Prices: the calendar has none, a stay quote does

Measured 2026-09-12 and 2026-09-13. Explains `priceQuotes.ts` and
`packages/scraper-airbnb/src/api/priceQuote.ts`.

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

That fetch is `StaysPdpSections` (persisted-query hash
`80c7889b…46bf1f`, taken from pyairbnb's `price.py`) with `checkIn`,
`checkOut` and `sectionIds: ["BOOK_IT_SIDEBAR"]`. The sidebar section's
`structuredDisplayPrice` for room 10403135, 2026-10-14 to 10-16 (abridged):

```json
{
  "primaryLine": {
    "accessibilityLabel": "$241 for 2 nights, originally $269",
    "discountedPrice": "$241",
    "originalPrice": "$269",
    "qualifier": "for 2 nights"
  },
  "explanationData": {
    "priceDetails": [
      { "items": [{ "description": "2 nights x $120.50", "priceString": "$241.00" }] },
      { "content": "Pay $0 today with no extra fees." }
    ]
  }
}
```

An undiscounted stay has `price` instead of `discountedPrice`. For dates that
can't be booked, `structuredDisplayPrice` is null and
`localizedUnavailabilityMessage` is `"Those dates are not available"`.

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
