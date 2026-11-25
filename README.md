# Anchorage STR Database

Work in progress!

A daily record of short-term rentals (STRs) in the Municipality of
Anchorage, Alaska: every Airbnb listing, the Muni's STR registrations, and
the parcels they sit on. For answering questions like:

- How many listings are there, and how many are active?
- What are they like: bedrooms, price, a whole home or a room, an owner
  renting their own place or a host with dozens of listings?
- Who owns the dwellings, and do they live in the Muni?
- How does that change over time, and between neighborhoods, price bands,
  sizes and listing types?

## What you get

- One DuckDB file, `anchorage_str.duckdb`, updated daily: Airbnb listings,
  hosts and nightly availability; the Muni's STR registrations and other
  business licenses; and every Muni parcel with its owner of record.
  Listings that show a registration id link through it to a street
  address, a parcel and an owner of record.
- Example queries in [`docs/policy_questions.sql`](docs/policy_questions.sql)
- A browser story at <https://nickcrews.github.io/anchorage-str-db/>: one
  chapter per policy question (revenue, nightly rates, occupancy, room tax,
  who owns the dwellings), with revenue and occupancy estimated in the
  browser

## Quick start

```sh
gh release download latest-data --repo NickCrews/anchorage-str-db -O anchorage_str.duckdb
duckdb anchorage_str.duckdb
```

```sql
-- Active listings with their registration's address and parcel owner
SELECT l.name, l.url, l.registration_address, p.owner_name
FROM listings_active_with_registration l
LEFT JOIN property_parcels p ON p.parcel_id = l.registration_parcel_id;
```

## Main tables and views

- `listings_active_with_host`: active listings with their host's name,
  years hosting, and listing counts
- `listings_active_with_registration`: active listings with the
  registration their page shows: address, parcel, community council,
  business name
- `calendar_current`: nightly availability for each listing
- `registrations`: one row per STR registration
- `property_parcels`: every Muni parcel: property type, living units,
  owner of record and mailing address, exemptions
- `hosts`, `licenses`: Airbnb hosts, and every Muni license of any type
- `source_freshness`: when each source last updated

## Documentation

- [Methodology](docs/methodology.md): where the data comes from, how the
  sources link, how history is kept, and what the data cannot tell you.
  Read its limitations before quoting a number.
- [Tables](docs/tables.md): every table and view, and how each is derived
- [docs/TERMINOLOGY.md](docs/TERMINOLOGY.md): the vocabulary the tables and docs use
- [Product requirements](docs/prd.md): who this is for and what it must do
- [`docs/research/`](docs/research): dated investigations behind the
  design decisions

## Contributing

To run the scrapers, change the schema, or work on the code, see
[CONTRIBUTING.md](CONTRIBUTING.md).
