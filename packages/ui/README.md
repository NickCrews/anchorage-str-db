# Anchorage STR DB viewer

A [SQLRooms](https://sqlrooms.org) app for browsing `anchorage_str.duckdb`.
Queries run in the browser with
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview); there is no server.

- **Overview**: active listings, booked tonight, distinct STRs over the last
  year, near-term booked/vacant nights, monthly distinct-STR trend, and
  bedroom mix.
- **Map**: current listings, colored by pin precision or price.
- **Listings**: a searchable table of current listings with a cover-photo
  thumbnail, room type, and their latest rating, review count and price
  quote.

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
