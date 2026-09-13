# Contributing

## Setup

```sh
pnpm install
```

The workspace has two packages, `packages/scraper` and `packages/ui`, sharing
the compiler options in `tsconfig.base.json`.

Relative imports use their real `.ts` extension, so `node src/cli.ts` runs the
sources directly (Node strips the types) and `tsc` rewrites the extension to
`.js` in `dist/`. For the same reason `erasableSyntaxOnly` is on: no enums,
namespaces, or parameter properties.

## Running

```sh
pnpm daily                 # writes data/anchorage_str.duckdb
pnpm daily --verbose --db /tmp/scratch.duckdb
```

Run from the repo root. The root `daily` script calls
`packages/scraper/src/cli.ts` directly; `pnpm --filter` would set the working
directory to the package and put the default `--db` under
`packages/scraper/data/`.

A run searches the Anchorage bounding box, fetches every listing's page and
calendar and up to 1000 listings' earliest review dates, writes the day to the
database, and runs the data-quality checks.
It exits non-zero if an error-severity check fails; the log names which one.
`--verbose` logs passing checks too.

A run against an empty database creates the schema. `store.SCHEMA_SQL` runs
on every connect, so a new table (`CREATE TABLE IF NOT EXISTS`) or a nullable
column on `scrape_runs` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) reaches
the published database in place. Any other change has no migration and means
rebuilding the database.

### Dependencies

The scraper depends only on `impit` and `@duckdb/node-api`.

Airbnb sits behind Akamai, which fingerprints the TLS ClientHello and refuses
Node's built-in `fetch` regardless of `User-Agent`. `impit` replays a Chrome
handshake (`chrome124`, set in `src/airbnb/http.ts`). If every request starts
failing with 403, try a newer browser profile.

Arguments are parsed with `node:util.parseArgs`. The listing-page parser only
needs the JSON in `<script>` tags, which `src/html.ts` extracts with a regex.

`packages/scraper/src/airbnb/` has one file per Airbnb endpoint and its own
README.

### Fetch everything, then write everything

`runDaily` makes every network request (search, then a page and a calendar
per listing) before touching the database, then does all writes in a single
`db.transaction`.

DuckDB autocommits each statement, so without the transaction a crash during
the writes would leave a partial day that every query reads as complete.
`recordObservations` also deletes a date's rows before re-inserting them, so
a crash between the two would drop the day. A run therefore records a whole
day or nothing. The failed-run row in `scrape_runs` is written after the
rollback so it is not rolled back with the run.

The network passes stay outside the transaction because they take most of an
hour. A single listing's failed page or calendar fetch is recorded as an
error rather than aborting the run, and the failure-rate checks judge them in
aggregate.

### Listing-page pass

Every run fetches each listing's own page for fields the search response
lacks: Airbnb's `isExactLocation` flag (whether `location_lat`/`location_lng`
is the real position or jittered), the municipal STR registration number, and
the primary host's user id. They are stored on the same `listing_observations` row as the search fields.
When a page fetch fails, the `listings` view carries the previous values
forward.

The pass has no flag to skip it. A skipped pass would write rows whose page
fields are carried forward from an earlier day, and nothing in the database
could tell those rows from freshly read ones. See
[`docs/research/airbnb-pdp-location-payload.md`](docs/research/airbnb-pdp-location-payload.md)
and [`docs/research/airbnb-pdp-host-id.md`](docs/research/airbnb-pdp-host-id.md).

### First-review pass

Each run resolves the earliest review date of up to
`FIRST_REVIEW_MAX_PER_RUN` (1000) listings that don't have one yet, and stores
it in `listing_first_reviews`. The `listings` view derives
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

### Request budget

A run makes about `2N + 200` requests for N listings: a page and a calendar
per listing, plus one `StaysSearch` request per price band (see
[`docs/research/airbnb-search-pagination.md`](docs/research/airbnb-search-pagination.md)
for why the search never paginates). At ~2600 listings that is ~5400 requests
and about 50 minutes. The first-review pass adds about one request per
unresolved listing, at most ~1030 (~10 minutes) while backfilling and a handful
once caught up. The per-listing passes dominate.

The Airbnb API key is fetched once per run in `pipeline.ts` and passed to
every search and calendar request. It is a long-lived public value, and
fetching it per request would re-download the ~600 KB homepage for each
listing.

The shared request rate is in `pace.ts`. `retry.ts` holds the attempt loop
every pass uses: a 429 aborts the run, a streak of timeouts halves the
request rate, and any other error is retried.

## Inspecting the database

```sh
duckdb data/anchorage_str.duckdb
```

or run queries from [`docs/policy_questions.sql`](docs/policy_questions.sql).

## CI

[`.github/workflows/daily.yml`](.github/workflows/daily.yml) runs the same
pipeline daily from a `tsc` build of `packages/scraper`. Runners are
ephemeral, so each run downloads the database from the `latest-data` release,
scrapes, and re-uploads it if the checks pass. A `backup-YYYY-MM-DD` release
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
  - `calendar_status` stores only changed nights (via `status_hash`). A full
    daily snapshot would be ~2600 listings × ~365 nights = ~950k rows/day.
  - `listing_observations` is ~2600 rows/day and compresses well, so it
    stores every day and `listings` is a view: `listing_versions` rebuilds
    `valid_from`/`valid_to` with gaps-and-islands, and `listing_activity`
    derives first/last/page-seen dates.
- **Add listing columns to `listing_observations`, not `listings`.** If a
  change to the column should open a new version, also add it to
  `VERSION_KEY_SQL` in `store.ts`. Leave out values that move most days
  (price, review count).
- **Listings are never UPDATEd.** `first_seen_date`, `last_seen_date` and
  `page_seen_date` are derived from observations, so they stay correct for a
  listing that retires and later relists, and a bug in version logic is
  fixed by editing a view. This matters because the published `.duckdb` is
  the only copy of the archive.
- **Retirement is a view predicate.** A listing is current if seen within
  `RETIREMENT_GRACE_DAYS` (5) of the latest completed run, because search
  results occasionally omit a listing for a day. "Latest completed run" is
  the later of `max(scrape_date)` in the observations and in `scrape_runs`
  where `listings_seen IS NOT NULL`: the first alone stops advancing on a day
  with no listings, and the second alone would let a failed run retire every
  listing.
- **Read `calendar_current`, not `calendar_status`.** A retired listing's
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
  JSON-LD has no host, so `host_id` comes from `state` and `raw-html`, and
  `host_id_coverage` fails the run when both stop producing it.
- **The bounding box is derived from parcel data.** See the docstring in
  `config.ts`; recompute it from `anchorage-property` rather than editing
  coordinates by hand.

## Adding Vrbo

Not implemented. Vrbo's anti-scraping measures are stronger than Airbnb's,
so start by investigating what is reachable. Then:

- Add `src/vrbo/`, one file per endpoint, like `src/airbnb/`.
- Add a `source` column (default `'airbnb'`) to `listing_observations` and
  `calendar_status`, and change the views' `PARTITION BY listing_id` to
  `PARTITION BY source, listing_id`, since room ids are unique only per
  source.
- Most queries in `docs/policy_questions.sql` then need only a
  `GROUP BY source`.

## Tests

```sh
pnpm test        # vitest, both packages
pnpm typecheck
```

- `test/listingPage.test.ts` and `test/standardize.test.ts` parse synthetic
  Airbnb responses. They catch parser regressions but not changes on
  Airbnb's side.
- `test/store.test.ts` runs the merge logic against a real DuckDB file.

No test touches the network. Fetching is injected: `searchAnchorage` takes a
`fetchPage`, `fetchCalendars` takes a `fetchOne`, `fetchFirstReviews` takes a
`fetchPage`, and `liveSearchFetcher`, `liveCalendarFetcher`,
`livePageFetcher` and `liveReviewPageFetcher` are the only places real
requests are made.

When Airbnb changes something, `src/airbnb/` and `parse.ts` break without
failing a test. To debug a production failure, run `searchAnchorage` over a
small box and `livePageFetcher` against a few known room ids, and check the
`extraction_layer_*_alive` results from the last run.
