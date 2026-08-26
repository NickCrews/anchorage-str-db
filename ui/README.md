# Girdwood STR Lake — viewer

A [SQLRooms](https://sqlrooms.org) app for browsing the `girdwood_str.duckdb`
lake produced by this repo: everything runs client-side against
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) in your browser —
no server, no data leaves your machine.

- **Overview** — KPI cards (active listings, booked tonight, distinct STRs
  over the last year) and charts (near-term booked/vacant nights, the
  monthly distinct-STR trend, bedroom-size mix).
- **Listings** — a searchable, sortable table of the currently active
  listings with their latest rating/review/price snapshot.
- **SQL** — a full SQL editor over the lake, seeded with the ready-made
  questions from [`queries/policy_questions.sql`](../queries/policy_questions.sql).
  Save any result as a new table/view via "New table".
- **Data** (left sidebar) — the schema tree for `listings`,
  `listing_observations`, `calendar_status`, `scrape_runs`, plus a dropzone
  to join in a CSV/TSV/JSON/Parquet file locally (e.g. a parcel export).

## Running locally

```sh
# from the repo root, refresh the snapshot the UI reads:
cp data/girdwood_str.duckdb ui/public/girdwood_str.duckdb

cd ui
npm install
npm run dev
```

Then open the printed `localhost` URL. `npm run build` / `npm run preview`
work the same way for a production build.

## How data loading works

`public/girdwood_str.duckdb` is a snapshot copied in from `../data/`
(gitignored — see below). On startup, [`src/dataInitSlice.ts`](src/dataInitSlice.ts)
fetches that file, registers its bytes with the in-browser DuckDB-WASM
filesystem, `ATTACH`es it read-only, and creates `listings`,
`listing_observations`, `calendar_status`, and `scrape_runs` as views in the
main schema so the rest of the app can query them directly.

To pick up a newer scrape, just re-run the `cp` above and reload the page —
there's no build step involved in refreshing the data.

## Private data — do not deploy publicly

Per the root [README](../README.md#notes--caveats), this lake is
near-address-precision, listing-level scrape data and defaults to private.
`public/girdwood_str.duckdb` is gitignored, and there's deliberately no
Netlify/Vercel config here — `npm run build` bundles the snapshot straight
into `dist/`, so publishing that build anywhere public republishes the data.
If you want to share this UI, deploy it somewhere access-controlled and
confirm that's fine per the root README's guidance first.
