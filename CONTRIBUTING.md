# Contributing

## Setup

```sh
pnpm install
```

The workspace packages share the compiler options in `tsconfig.base.json`:

| package | does | runtime dependencies |
| --- | --- | --- |
| `packages/scraper` | runs the providers below, decides what is stored, writes, checks and the CLI | the five packages below |
| `packages/db` | the DuckDB schema (Drizzle), its migrations, the views, and the connection | `utils`, `scraper-muni-str`, `@duckdb/node-api`, `drizzle-orm`, `@duckdbfan/drizzle-duckdb` |
| `packages/scraper-airbnb` | searches Airbnb and fetches listing pages, calendars, price quotes and reviews | `utils`, `impit` |
| `packages/scraper-muni-str` | fetches the Municipal Clerk's STR registration layers from ArcGIS | `utils` |
| `packages/muni-licenses` | fetches and parses the Muni's CityView license pages | `utils` |
| `packages/utils` | dates, logging, concurrency, request pacing and retries, `fetch`, the Municipality boundary | none |
| `packages/ui` | the browser viewer | `db` (schema only), `drizzle-orm`, SQLRooms |

Provider packages (`scraper-airbnb`, `scraper-muni-str`, `muni-licenses`)
work in memory: they return typed records and never touch DuckDB, so each
can be tested and debugged without a database. Only `packages/scraper`
decides what is stored.

Nothing is compiled. Each package exports its sources
(`"exports": {"./*": "./src/*.ts"}`, imported as
`@anchorage-str-db/utils/dates`), relative imports use their real `.ts`
extension, and Node strips the types when it runs them. For the same reason
`erasableSyntaxOnly` is on: no enums, namespaces, or parameter properties.
`pnpm typecheck` is the only type check.

## Running

```sh
pnpm daily                 # Airbnb; writes data/anchorage_str.duckdb
pnpm daily --verbose --db /tmp/scratch.duckdb
pnpm registry              # the Municipal STR registry, same database
```

The default `--db` is resolved from the scraper's source, so it is the repo's
`data/anchorage_str.duckdb` from any working directory.

A run searches the Anchorage bounding box, keeps the listings inside the
Municipality's boundary (`utils/src/muni_geography`), fetches every listing's
page and calendar and up to 1000 listings' earliest review dates, writes the
day to the database, and runs the data-quality checks.
It exits non-zero if an error-severity check fails; the log names which one.
`--verbose` logs passing checks too.

### Changing the schema

The tables are defined with Drizzle in `packages/db/src/schema.ts`. Every run
opens the database with `connect` (`packages/db/src/connect.ts`), which
applies the migrations in `packages/db/drizzle` that the database has not
recorded, rejects any table that differs from what the migrations create or
that the schema does not declare, and recreates the views. A run against an
empty database creates everything.

A table's name starts with its source (`airbnb_`, `muni_str_`,
`muni_license_`), so a new source gets a new prefix. Views have none.

To change a table:

1. Edit `schema.ts`. Add a column at the end of its table: `appendRows`
   writes values in declared order.
2. Run `pnpm --filter @anchorage-str-db/db generate --name <change>`.
3. Read the generated SQL. drizzle-kit writes Postgres DDL, which DuckDB
   mostly accepts; it quotes a struct type (`"STRUCT(a VARCHAR)"[]`), which
   DuckDB reads as a type name, so remove those quotes.
4. Run the tests. `packages/db/test/connect.test.ts` builds a database from
   the migrations.

The next run applies the migration to the published database.

Views are SQL in `packages/db/src/views.ts`. They need no migration, but
their columns are declared a second time, as Drizzle views, in
`packages/db/src/viewSchema.ts`: that is what a reader writes queries from,
and the viewer's every query is built out of it. `connect` compares the two
and refuses the database if they differ, so a view that gains, loses or
retypes a column has to be re-declared there in the same order. The error
names the view and the column.

### Reading the database from the browser

The viewer runs the same schema through DuckDB-WASM, so part of
`packages/db` has to be importable in a browser: `schema.ts`, `viewSchema.ts`,
`catalog.ts`, `columns.ts`, `sql.ts` and `rows.ts` reach nothing but
`drizzle-orm` and `@duckdbfan/drizzle-duckdb/helpers`, that package's
driverless entry point. The scraper's side is `database.ts` and `connect.ts`,
which load `@duckdb/node-api`, a native addon, and `views.ts`, which reads a
constant from the Muni scraper. `packages/db/test/browserSafe.test.ts` walks
the imports and fails if the two sides meet.

What crosses the line is the schema, not a connection:

- The viewer builds its SQL from the same table and view objects the scraper
  writes through, with `toSql` (`sql.ts`) rendering a Drizzle query to one
  string for SQLRooms to run. A renamed column is a type error in the viewer
  rather than a query that returns nothing.
- Every query is built with Drizzle's query builder (`new QueryBuilder()` from
  `drizzle-orm/pg-core`, which builds SQL without a connection), so the
  compiler sees each `select`, `join`, `where` and `group by` against the
  relation it names. DuckDB syntax the Postgres dialect has no notion of
  (`FILTER`, `GROUP BY ALL`, `EXCLUDE`, `QUALIFY`) goes in a `sql` fragment
  inside the built query — a selected expression, a `where`, a subquery, or a
  `$with` CTE with its columns declared — rather than turning the query back
  into a string.
- The two drivers hand back different JavaScript for the same column, so
  `rows.ts` has a row type for each: `NodeRow` for `Database.rows()`, where a
  `DATE` is `'2026-09-11'` and a `BIGINT` a decimal string, and `WasmRow` for
  the viewer, where the same `DATE` is epoch milliseconds and the `BIGINT` a
  `bigint`. `WasmSelection` is the same mapping over a query's own selection,
  for a row the viewer reads back in JavaScript.
- A query's own invented columns (a `status` a `CASE` derives, a count it
  names) stay plain SQL text. Only database relations come from the schema.

### Dependencies

The only third-party runtime dependencies are `impit`, `@duckdb/node-api`,
`drizzle-orm` and `@duckdbfan/drizzle-duckdb`, which adapts Drizzle's
Postgres support to DuckDB.

Airbnb sits behind Akamai, which fingerprints the TLS ClientHello and refuses
Node's built-in `fetch` regardless of `User-Agent`. `impit` replays a Chrome
handshake (`chrome124`, set in `scraper-airbnb/src/api/http.ts`). If every
request starts failing with 403, try a newer browser profile. ArcGIS Online
and the CityView portal accept Node's `fetch`.

Arguments are parsed with `node:util.parseArgs`. The listing-page parser only
needs the JSON in `<script>` tags, which `scraper-airbnb/src/html.ts` extracts
with a regex; the license page parser reads server-rendered HTML the same way.

`packages/scraper-airbnb/src/api/` has one file per Airbnb endpoint and its
own README.

### Fetch everything, then write everything

`runDaily` makes every network request (search, then a page and a calendar
per listing) before touching the database, then does all writes in a single
`db.transaction`.

DuckDB autocommits each statement, so without the transaction a crash during
the writes would leave a partial day that every query reads as complete.
`recordObservations` also deletes a date's rows before re-inserting them, so
a crash between the two would drop the day. A run therefore records a whole
day or nothing. The failed-run row in `airbnb_scrape_runs` is written after the
rollback so it is not rolled back with the run.

The network passes stay outside the transaction because they take most of an
hour. A single listing's failed page or calendar fetch is recorded as an
error rather than aborting the run, and the failure-rate checks judge them in
aggregate.

### Listing-page pass

Every run fetches each listing's own page for fields the search response
lacks or reports unreliably: Airbnb's `isExactLocation` flag (whether
`location_lat`/`location_lng` is the real position or jittered), the
municipal STR registration number, the primary host's user id, room type,
guest, bed, bedroom and bathroom counts, and photos. All but photos are
stored on the same `airbnb_listing_observations` row as the search fields. When a
page fetch fails, the `listings` view carries the previous values forward.

The pass has no flag to skip it. A skipped pass would write rows whose page
fields are carried forward from an earlier day, and nothing in the database
could tell those rows from freshly read ones. See
[`docs/research/airbnb-pdp-location-payload.md`](docs/research/airbnb-pdp-location-payload.md),
[`docs/research/airbnb-pdp-host-id.md`](docs/research/airbnb-pdp-host-id.md)
and [`docs/research/airbnb-pdp-listing-attributes.md`](docs/research/airbnb-pdp-listing-attributes.md).

### Price-quote pass

After the calendar pass, each run asks `StaysPdpSections` for the price of
one stay per listing: the earliest stay the calendar says is bookable,
checking in tomorrow or later, for the listing's minimum number of nights
(`priceQuotes.ts`). A fully booked listing gets no quote. The response is
stored as Airbnb displays it, on the day's `airbnb_listing_observations` row;
nightly rates are left to analysis. See
[`docs/research/airbnb-calendar-price.md`](docs/research/airbnb-calendar-price.md).

### First-review pass

Each run resolves the earliest review date of up to
`FIRST_REVIEW_MAX_PER_RUN` (1000) listings that don't have one yet, and stores
it in `airbnb_listing_first_reviews`. The `listings` view derives
`first_available_date_est` from it. A listing is resolved once: a first
review never changes, and a listing with no reviews stores NULL and is not
fetched again, since a later first review would fall after its
`first_seen_date` and couldn't change the estimate. A failed fetch writes no
row, so the listing is retried next run.

Airbnb's reviews endpoint sorts newest first and has no oldest-first option,
so `firstReviews.ts` requests the tail of the list at an offset taken from
search's review count, and requests again at Airbnb's own total when that
count was stale. Search omits the count for listings with very few reviews.
Only each review's `createdAt` is read; no review text or reviewer data is
kept.

The pass is capped so the ~2600-listing backfill spreads over about three runs
instead of adding ~25 minutes to one. In a sample of 200 listings it made 206
requests. Its `first_review_failure_rate` check is a warning: a failure is
retried next run, and failing the run would withhold that day's calendar and
listings, which can't be scraped after the fact.

### Host pass

Every listing page carries its primary host's profile card (name, bio,
`timeAsHost`), so the host pass makes no requests. `collectHostCards` reduces
the run's pages to one card per distinct host (about 2 listings per host),
and `recordHostObservations` writes a row for every host with a listing
observed that day, including hosts whose only page failed.

### Request budget

A run makes about `3N + 200` requests for N listings: a page, a calendar and
a price quote per listing (the host pass adds none), plus one `StaysSearch`
request per price band (see
[`docs/research/airbnb-search-pagination.md`](docs/research/airbnb-search-pagination.md)
for why the search never paginates). At ~2600 listings that is ~8000 requests
and about 75 minutes. The first-review pass adds about one request per
unresolved listing, at most ~1030 (~10 minutes) while backfilling and a handful
once caught up. The per-listing passes dominate.

The Airbnb API key is fetched once per run in `pipeline.ts` and passed to
every search and calendar request. It is a long-lived public value, and
fetching it per request would re-download the ~600 KB homepage for each
listing.

The shared Airbnb request rate is in `scraper-airbnb/src/pace.ts`, and
`scraper-airbnb/src/retry.ts` wraps the attempt loop from `utils/src/retry.ts`
that every pass uses: a 429 aborts the run, a streak of timeouts halves the
request rate, and any other error is retried.

## The registry run

`pnpm registry` (`packages/scraper/src/registry.ts`) records the
Municipality's STR registrations. It is a separate command from `daily`, with
its own transaction, run log (`muni_str_registry_runs`) and checks
(`registryChecks.ts`), so an outage at either source leaves the other's day
intact. It takes 5 to 15 minutes, depending on how quickly the license
portal responds.

Each run:

1. Fetches every registration from the Clerk's
   [registration viewer](https://experience.arcgis.com/experience/22b40a78a9fc459e9950a16249b37ed2)
   (`scraper-muni-str`). A layer that doesn't add up to the server's own
   count fails the run, since a partial snapshot would read as registrations
   lapsing.
2. Reads up to `LICENSE_PAGE_MAX_PER_RUN` (500) CityView license pages
   (`muni-licenses`), chosen by `chooseLicensePages`: never-read licenses
   first, then licenses that left the layer and haven't been read since, then
   current licenses whose latest read is `LICENSE_PAGE_REFRESH_DAYS` (7) old.
   A failed read writes nothing and is retried next run.
3. Writes the day's layer snapshot and the pages, then runs the checks.

The layer lists only `Active` registrations and is republished about weekly
(`published_at`). A registration missing from a run's snapshot has lapsed or
been withdrawn; the license page read after it leaves records its final
status.

The license page is the only source for the licensee's own description of
the business, the parcel id, and every certificate issued under the license.
The layer's `StatusUrl` links to it; its `licenseId` keys `muni_license_page_reads`.

What the Muni publishes, and how it is cleaned:

- `BusinessName` is the string `'None'` when none was given. Stored as
  published; `registrations.business_name` is NULL.
- A `Location` the Muni's geocoder couldn't match has `GeocodedAddress`
  `'Incomplete address provided. No Match.'` and the placeholder point
  (-150.20935, 61.153442). Stored as published; `registrations.geocoded_lat`/`lng`
  are NULL.

## Inspecting the database

```sh
duckdb data/anchorage_str.duckdb
```

or run queries from [`docs/policy_questions.sql`](docs/policy_questions.sql).

## CI

[`.github/workflows/daily.yml`](.github/workflows/daily.yml) runs `registry`
then `daily` every day, after `pnpm typecheck` on `packages/scraper` and the
packages it imports. Runners are ephemeral, so each run downloads the
database from the `latest-data` release, scrapes, and re-uploads it if the
`daily` checks pass.

A failed registry run doesn't stop the Airbnb scrape or the upload: it rolled
back its own writes, and the Airbnb day can't be scraped later. The job
fails after uploading, which opens the outage issue. A `backup-YYYY-MM-DD` release
is created every Sunday and kept indefinitely.

A failed run opens a `pipeline-down` issue; the next successful run closes
it. If `latest-data` has no database, the run fails unless dispatched with
`start_fresh=true`.

The workflow needs no secrets; `gh` uses the automatic `GITHUB_TOKEN`.

### When the published database has an incompatible schema

Every run fails with `LegacySchemaError` until someone:

1. Copies the `latest-data` asset to its own release, named for the schema
   it holds (e.g. `archive-<date>`).
2. Deletes it: `gh release delete-asset latest-data anchorage_str.duckdb`
3. Starts over: `gh workflow run daily.yml -f start_fresh=true`

## Design decisions

- **Change-only storage for the calendar, a row per day for listings.**
  - `airbnb_calendar_status` stores only changed nights (via `status_hash`). A full
    daily snapshot would be ~2600 listings × ~365 nights = ~950k rows/day.
  - `airbnb_listing_photos` stores a listing's gallery only when it differs from
    the previous one. A median of ~17 URLs on every daily row would dominate
    the published file, which the viewer downloads whole.
  - Photos are not in the version key. Hosts reorder and replace photos far
    more often than a listing changes.
  - `airbnb_listing_observations` is ~2600 rows/day and compresses well, so it
    stores every day and `listings` is a view: `listing_versions` rebuilds
    `valid_from`/`valid_to` with gaps-and-islands, and `listing_activity`
    derives first/last/page-seen dates.
- **Add listing columns to `airbnb_listing_observations`, not `listings`.** If a
  change to the column should open a new version, also add it to
  `VERSION_KEY_SQL` in `packages/db/src/views.ts`. Leave out values that move most days
  (price, review count).
- **Hosts are stored the same way.** `airbnb_host_observations` is append-only with
  a `profile_read_ok` flag, and `hosts` rebuilds versions with the same
  gaps-and-islands and carry-forward as `listings`. Name and bio are the
  version key. `timeAsHost` grows monthly, so `host_activity` summarizes it
  as the earliest implied start date plus the spread between readings, and
  `host_start_date_stable` warns when that spread exceeds
  `HOST_START_MAX_SPREAD_DAYS`. The host checks are warnings because the
  views carry every host's last read forward.
- **Portfolio size is counts, not a classification.** `host_portfolios` is
  derived from `airbnb_listing_observations.host_id` with no extra requests, as a
  time series. Where an owner ends and an operator begins is left to
  downstream users, so no threshold is stored; the viewer's cutoff is a
  labelled display choice. It counts only listings in the search area.
- **Listings are never UPDATEd.** `first_seen_date`, `last_seen_date` and
  `page_seen_date` are derived from observations, so they stay correct for a
  listing that retires and later relists, and a bug in version logic is
  fixed by editing a view. This matters because the published `.duckdb` is
  the only copy of the archive.
- **Retirement is a view predicate.** A listing is current if seen within
  `RETIREMENT_GRACE_DAYS` (5) of the latest completed run, because search
  results occasionally omit a listing for a day. "Latest completed run" is
  the later of `max(scrape_date)` in the observations and in `airbnb_scrape_runs`
  where `listings_seen IS NOT NULL`: the first alone stops advancing on a day
  with no listings, and the second alone would let a failed run retire every
  listing.
- **Registrations are stored raw, and joined to listings in views.**
  `muni_str_registration_observations` and `muni_license_page_reads` hold what the Muni publishes, with its field values
  unchanged. `registrations` derives one row per registration from them, and
  `listings_current_with_registration` joins Airbnb listings on
  `str_registration_id`, so a cleaning or join rule is fixed by editing a
  view. The registration snapshot is stored every run, like
  `airbnb_listing_observations`, rather than change-only: ~2500 rows compress to
  ~50 KB a day, and a row per run gives exact first- and last-seen dates.
- **Read `calendar_current`, not `airbnb_calendar_status`.** A retired listing's
  calendar is no longer fetched, so its future nights stay `is_current` in
  the raw table for up to twelve months. `calendar_current` drops nights after
  the listing's last sighting and keeps the ones before it.
- **Undated search.** `searchAnchorage` sends no check-in/check-out, so
  Airbnb returns every listing in the area rather than only those free on
  given nights. Availability comes from the calendar.
- **Calendar days before the scrape date are dropped.** Airbnb's calendar
  starts on the 1st of the current month and marks elapsed days
  `available: false`. `toNights(days, minDate)` filters them so they don't
  read as bookings. The unit test covers the filter, not Airbnb's response
  shape, so check live output after changing calendar parsing.
- **About half of the coordinates are jittered; `location_is_exact` says
  which.** Airbnb offsets the pin unless the host shows the exact location.
  Filter on `location_is_exact` before any spatial join to parcels or
  addresses. The flag sits next to the coordinate in `listings` so that
  filter needs no join. The jitter is stable per listing, so repeated
  scraping does not average it out. `location_exact_address` is stored when
  Airbnb provides it and is null for most listings. Before adding geocoding
  or parcel matching, read
  [`docs/research/airbnb-address-deanonymization.md`](docs/research/airbnb-address-deanonymization.md),
  which recommends a public-records request to the Municipality instead.
- **The listing-page parse has three layers.** `listingPage.ts` extracts the
  same fields from schema.org JSON-LD, a shape search over the embedded
  GraphQL state, and regexes over the raw HTML, because none of it is a
  documented API. Each page records which layers contributed
  (`ListingPage.locationSource`, in memory only), and the
  `extraction_layer_*_alive` checks fail when a layer stops producing values.
  JSON-LD has only the coordinate, so the other fields come from `state` and
  `raw-html`, and photos from `state` alone (JSON-LD lists at most 8). The
  `*_coverage` and `photo_coverage` checks fail the run when a field stops
  being produced.
- **Room counts and type come from the listing page, not search.** Search
  cards show them only as free text, carry no guest line, and drop the bath
  line on some days, which would open a spurious version each time.
- **Text is stored as Airbnb writes it.** Room type, bedrooms and bathrooms
  exist only as display text (`Entire home/apt`, `Studio`, `Shared
  bathroom`), so they are stored verbatim rather than mapped to categories or
  numbers: a new wording can't be misread, and analysis can re-derive
  anything from the original. The parser only picks out which line is which.
  Guest capacity and beds are integers in Airbnb's data and are stored as
  such.
- **The Municipality boundary is generated from the Muni's community council
  polygons.** `utils/src/muni_geography/municipality.sql` builds
  `municipality.geojson` and explains the 1 km padding; rerun it rather than
  editing the GeoJSON by hand. The Airbnb search covers the boundary's
  bounding box (`MUNICIPALITY_BOUNDING_BOX`).

## Adding Vrbo

Not implemented. Vrbo's anti-scraping measures are stronger than Airbnb's,
so start by investigating what is reachable. Then:

- Add `packages/scraper-vrbo/`, in memory like `scraper-airbnb`, with one
  file per endpoint, and call it from `packages/scraper`.
- Add a `source` column (default `'airbnb'`) to `airbnb_listing_observations` and
  `airbnb_calendar_status`, and change the views' `PARTITION BY listing_id` to
  `PARTITION BY source, listing_id`, since room ids are unique only per
  source.
- Most queries in `docs/policy_questions.sql` then need only a
  `GROUP BY source`.

## Tests

```sh
pnpm test        # vitest, every package
pnpm typecheck
```

- `scraper-airbnb/test/listingPage.test.ts` and `standardize.test.ts` parse
  synthetic Airbnb responses. They catch parser regressions but not changes
  on Airbnb's side.
- `muni-licenses/test/licensePage.test.ts` reads real license pages from the
  Muni's portal, one per markup case the parser handles (listed in that
  package's README), so it fails when the portal's markup changes.
- `scraper-muni-str/test/addresses.test.ts` and
  `scraper/test/addressProvenance.test.ts` read the live registration layer
  and license pages and check where each address field comes from:
  `Location` is the license's address (a property record's, or typed text),
  and the geocoded fields are derived from it.
- `scraper/test/store.test.ts` and `registryStore.test.ts` run the merge
  logic and views against a real DuckDB file.
- `db/test/connect.test.ts` checks that migrations apply once and that an
  incompatible file is rejected; `database.test.ts` checks how `appendRows`
  converts values.

The tests above need the network; no other test does. Fetching is injected: `searchAnchorage` takes a
`fetchPage`, `fetchCalendars` takes a `fetchOne`, `fetchFirstReviews` takes a
`fetchPage`, and `fetchRegistrations` takes a `fetchJson`. The `live*Fetcher` functions are the
only places real requests are made.

When Airbnb changes something, `scraper-airbnb/src/api/` and `parse.ts` break
without failing a test. To debug a production failure, run `searchAnchorage` over a
small box and `livePageFetcher` against a few known room ids, and check the
`extraction_layer_*_alive` results from the last run.
