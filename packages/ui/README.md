# Anchorage STR DB viewer

A scrolling story about short-term rentals in the Muni, built on
`anchorage_str.duckdb`. Queries run in the browser with
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview), through
[SQLRooms](https://sqlrooms.org)' DuckDB connector, and cross-filter with
[Mosaic](https://idl.uw.edu/mosaic/); there is no server.

The page is written for the general public. A banner says it is a work in
progress, not to be quoted, with a contact address. The header holds the
Methodology menu, links to each section and a link to this repository.

The page asks one question per section. The left column holds the
question, a sticky chart with its controls, and the narrative steps
scrolling beneath it. The right column holds a sticky map above a table of
the section's listings. The step in the reading band below the chart sets
the chart's view; a control the reader changes overrides it until the next
step, and "back to the story" restores it.

The chart, map and table cross-filter through one Mosaic selection per
section. Dragging across a histogram, clicking a bar in a click-to-filter
chart, or clicking a category or brushing a range in a table column's
header narrows all three; "N filters · clear" resets them. Clicking a dot
on the map or a row in the table opens that listing's details over the map.

The Methodology menu, top left, explains in plain language where the
numbers come from, what they assume and what they can't tell, and holds
the page-wide choice of model: low, middle or high estimate, which decides
how closed nights are counted (`src/story/model.ts`). Every chart, map and
table follows it; the narrative quotes the middle estimate and gives the
low-to-high range where it matters. Closed, the menu shows the current
model under its name.

| Section | Question |
| --- | --- |
| Earnings | How much does a short-term rental earn? |
| Hosts | Who runs them, and how much do they make? |
| Prices | What does a night cost? |
| Occupancy | How often are they booked? |
| How many | How many are there, and are they registered? |
| Rent long-term? | Would owners earn more renting long-term? |
| Visitors | How many visitors do they house? |
| Neighborhoods | What do they take from neighborhoods? |
| Room tax | What do they pay the Muni in room tax? |
| Who earns | Who earns the money? |
| Baseline | Where do things stand today? |

The long-term rents and running costs in "Rent long-term?" are editable.
"Visitors" lists the hotel and room-tax data it still needs.

## Registration problems

`registration-problems.html` is a second page, served at `/registration-problems`, linked from the header and
the "How many" section, laid out like the report in
[`docs/research/registration-location-mismatch`](../../docs/research/registration-location-mismatch/README.md):
a card per problem with an example and a suggested fix, a table of every
case that filters, searches, copies and downloads as CSV, and a case-by-case
view with a Leaflet map of the listing, its registered address, the other
listings showing its id and the registrations near it. The queries are in
[`src/problems/sql.ts`](src/problems/sql.ts) and the sorting and wording in
[`src/problems/problems.ts`](src/problems/problems.ts). Each active listing
gets the first problem that applies:

| Problem | Test |
| --- | --- |
| No id shown | the listing shows no registration id |
| Id not on file | no registration has the id |
| Registration lapsed | the registration is not active |
| Likely the wrong id | more than 500 m from the registration's geocoded coordinate, and a registration within 200 m of the listing has a matching business name, host name or title |
| One id, two places | more than 500 m from it, and another listing with the id is within 500 m of it |
| Not at the registered address | more than 500 m from it, and neither of the above |

## Estimates

Revenue and occupancy are not in the database, which records only what
Airbnb publishes: one open/closed bit per night and a price for an open
stay. [`src/model/estimates.ts`](src/model/estimates.ts) builds the `est_*`
tables after the database loads:

- `est_nights`: each listing-night's state on the last run before it,
  classified as open, blocked (in a run of more than 14 closed nights),
  booked and observed (seen open earlier), or booked and inferred
- `est_quotes`, `est_listing_rate`: median quoted nightly price per listing
  per check-in month, and overall
- `est_listing_months`: per listing per month, nights by state, the nightly
  rate, and occupancy and revenue with low and high bounds
- `est_listings`: each listing's latest version with its host,
  registration, area, parcel and parcel owner

The Methodology menu explains them to readers.

## Layout

- `src/story/Story.tsx`: the page: banner, header, introduction and section order
- `src/story/Chapter.tsx`: `Chapter`, which tracks the active step,
  `ChapterGrid`, the two-column layout, and `useStepState`, the per-step
  view presets
- `src/story/chapters/`: one file per chapter
- `src/story/Methodology.tsx`: the Methodology menu
- `src/story/xf/`: the cross-filtering. `XfProvider` builds a section's
  table (`table.ts`: one row per listing for the chosen month and model,
  with plain-word column names that become the table headers; named per
  section, model and month because Mosaic caches results by query text)
  and owns its selection; `XfHistogram` is a brushable vgplot
  histogram; `XfSide` stacks `XfMap` over `XfTable` with `ListingDetail`;
  `clause.ts` lets a plain chart filter on click. Charts that query other
  tables restrict them with `selectedListingsSql`.
- `src/story/near.ts`: a chapter mounts its chart, map and table only near
  the viewport, since each map holds two WebGL contexts and browsers cap a
  page at about sixteen
- `src/story/context.tsx`: the month the story quotes, the latest complete
  one
- `src/problems/`: the registration problems page
- `src/room.tsx`: the database and theme around either page

## Published site

[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml) builds the
viewer with the `latest-data` database and deploys it to GitHub Pages at
<https://nickcrews.github.io/anchorage-str-db/> on every push to `main` and
after each source workflow (Airbnb scrape, license scrape, parcel scrape)
publishes. The repo's Pages source must be set to "GitHub
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
new data. The "Rent long-term?", "Neighborhoods" and "Who earns" sections need `property_parcels`' owner columns; a
database whose last parcel scrape predates them needs `pnpm scrape parcels` first.

## Data loading

The `serveDatabase` plugin in [`vite.config.ts`](vite.config.ts) serves
`data/anchorage_str.duckdb` at `/anchorage_str.duckdb` in dev and copies it
into `dist/` on build; a build without it fails. On startup,
[`src/dataInitSlice.ts`](src/dataInitSlice.ts) fetches that file, attaches it
read-only, creates a view in the main schema for each name in `LAKE_TABLES`,
and builds the estimate tables.
