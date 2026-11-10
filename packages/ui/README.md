# Anchorage STR DB viewer

A [SQLRooms](https://sqlrooms.org) app for browsing `anchorage_str.duckdb`.
Queries run in the browser with
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview); there is no server.

- **Overview**: active listings, nights not available tonight, distinct
  listings over the last year, current Muni registrations and how many
  listings show one, registration status by listing type and community council,
  host concentration, near-term available vs. not, monthly distinct-listing
  trend, active listings by year first available, and bedroom mix.
- **Map**: every current Airbnb listing plus every active registration no
  Airbnb listing cites, colored by registration status or price. A listing is
  placed at its registration's geocoded license address when it has one,
  otherwise at Airbnb's pin; filled dots are known locations and rings are
  Airbnb's approximate pins.
- **Listings**: a searchable table of active listings with a cover-photo
  thumbnail, listing type, their latest rating, review count and price quote,
  host name, years hosting, the host's portfolio size, registration status
  with the registered address and parcel, and estimated first-available date.
  Filters by registration status.
- **Hosts**: a searchable table of Airbnb hosts with active listings: listing
  count, distinct registration ids, listings per registration status, and
  the business names on the registrations their listings cite. Filters to
  hosts with 2+ listings or with listings that show no number.
- **Registrations**: a searchable table of the Muni's STR registrations with
  their license page description and the number of current Airbnb listings
  citing each. Filters to active, active with no Airbnb listing, or
  lapsed.

Registration status compares the number a listing page shows with the
registry, the STR certificates on the Muni's license pages: `Registered`,
`Registration lapsed` (its certificate is no longer Active), `Id not in
registry` (includes numbers issued since the last license scan), or `No id
shown`.

## Published site

[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml) builds the
viewer with the `latest-data` database and deploys it to GitHub Pages at
<https://nickcrews.github.io/anchorage-str-db/> on every push to `main` and
after every daily scrape. The repo's Pages source must be set to "GitHub
Actions" (Settings → Pages).

## Running locally

The viewer reads the repo's `data/anchorage_str.duckdb`. From the repo root:

```sh
# Only without a local database: download the latest published one.
mkdir -p data
gh release download latest-data --repo NickCrews/anchorage-str-db -O data/anchorage_str.duckdb

pnpm --filter @anchorage-str-db/ui dev
```

Open the printed `localhost` URL. After a scrape, reload the page to see the
new data.

## Data loading

The `serveDatabase` plugin in [`vite.config.ts`](vite.config.ts) serves
`data/anchorage_str.duckdb` at `/anchorage_str.duckdb` in dev and copies it
into `dist/` on build; a build without it fails. On startup,
[`src/dataInitSlice.ts`](src/dataInitSlice.ts) fetches that file, attaches it
read-only, and creates a view in the main schema for each name in
`LAKE_TABLES`.
