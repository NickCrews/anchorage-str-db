# Anchorage STR Database

Work in progress!

A daily record of Airbnb short-term rentals (STRs) in the Municipality of
Anchorage, Alaska, for answering questions like:

- How many listings are there, how many are active?
- What is the character of these rentals: number of bedrooms, price, run by an on-premise owner vs a host with many listings
- How has that changed over time? How does it vary between neighborhoods, price bands, size, listing type, etc?

## What you get

- One DuckDB file, `anchorage_str.duckdb`, with daily snapshots of listings
  and calendar availability, and of the Municipality's STR registrations
- Policy queries in [`docs/policy_questions.sql`](docs/policy_questions.sql)
- A browser story, published at
  <https://nickcrews.github.io/anchorage-str-db/>: one chapter per policy
  question (listing and host revenue, nightly rates, occupancy, room tax, who
  owns the dwellings), with estimates of revenue and occupancy computed in
  the browser

## Quick start

```sh
gh release download latest-data --repo NickCrews/anchorage-str-db -O anchorage_str.duckdb
duckdb anchorage_str.duckdb
```

```sql
SELECT count(*) FROM listings WHERE is_active;
```

## Main tables and views

- `listings_active_with_host`: active listings with their host's name,
  years hosting, and portfolio counts
- `listings_active_with_registration`: active listings with the STR
  registration their page shows: address, parcel, business name
- `calendar_current`: nightly availability for each listing
- `hosts`, `registrations`, `licenses`, `property_parcels`: hosts, STR
  registrations, all Muni licenses, and the Muni's parcels with owner of record
- `source_freshness`: when each upstream source last updated successfully

The full reference, with every column group and how each is derived, is in
[`docs/tables.md`](docs/tables.md).

## Known gaps

- **Prices are quotes for available stays, not a nightly series.** Airbnb
  prices a stay only while it can be booked, so nights that are not
  available — the ones revenue is made of — have no price. Each day's quote
  is the listing's earliest bookable stay. See
  [`docs/research/airbnb-calendar-price.md`](docs/research/airbnb-calendar-price.md).

- **Unregistered listings have no street address.** A listing showing a
  registration id gets the registered address and parcel from
  `listings_active_with_registration` (2047 of 2628 active listings on
  2026-09-13). For the rest, `location_exact_address` is null unless the
  host published one. Join on `location_lat`/`location_lng`, and filter on
  `location_is_exact` first: about half those coordinates are Airbnb's
  privacy jitter.

## Contributing

To run the scrapers, change the schema, or work on the code, see
[CONTRIBUTING.md](CONTRIBUTING.md). For the vocabulary the tables and docs
use, see [CONTEXT.md](CONTEXT.md). For goals, see the [PRD](docs/prd.md).
