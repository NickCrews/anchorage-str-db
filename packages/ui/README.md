# Anchorage STR DB viewer

A [SQLRooms](https://sqlrooms.org) app for browsing `anchorage_str.duckdb`.
Queries run in the browser with
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview); there is no server.

- **Overview**: active listings, booked tonight, distinct STRs over the last
  year, current Muni registrations and how many listings show one,
  registration status by room type and community council, host
  concentration, near-term booked/vacant nights, monthly distinct-STR trend,
  current listings by year first available, and bedroom mix.
- **Map**: every current Airbnb listing plus every current registration no
  Airbnb listing cites, colored by registration status or price. A listing is
  placed at its registration's geocoded license address when it has one,
  otherwise at Airbnb's pin; filled dots are known locations and rings are
  Airbnb's approximate pins.
- **Listings**: a searchable table of current listings with a cover-photo
  thumbnail, room type, their latest rating, review count and price quote,
  host name, years hosting, the host's portfolio size, registration status
  with the registered address and parcel, and estimated first-available date.
  Filters by registration status.
- **Hosts**: a searchable table of Airbnb hosts with current listings: listing
  count, distinct registration numbers, listings per registration status, and
  the business names on the registrations their listings cite. Filters to
  hosts with 2+ listings or with listings that show no number.
- **Registrations**: a searchable table of the Muni's STR registrations with
  their license page description and the number of current Airbnb listings
  citing each. Filters to current, current with no Airbnb listing, or no
  longer published.

Registration status compares the number a listing page shows with the
registry: `Registered`, `Registration not current` (no longer published),
`Number not in registry` (includes numbers issued since the Muni's last
publish), or `No number shown`.

## Running locally

From the repo root:

```sh
cp data/anchorage_str.duckdb packages/ui/public/anchorage_str.duckdb
pnpm --filter @anchorage-str-db/ui dev
```

Open the printed `localhost` URL. To load newer data, copy the file again and
reload the page.

## Data loading

On startup, [`src/dataInitSlice.ts`](src/dataInitSlice.ts) fetches
`public/anchorage_str.duckdb`, attaches it read-only, and creates a view in
the main schema for each name in `LAKE_TABLES`.
