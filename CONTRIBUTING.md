# Contributing

Every name in this repo — table, column, identifier, comment, UI string —
comes from [docs/TERMINOLOGY.md](./docs/TERMINOLOGY.md). Read it before adding a concept, and
add the term there before using it. For how the sources fit together and
what the data can't tell, read [docs/methodology.md](docs/methodology.md)
first; this file covers how the code does it.

## Setup

```sh
pnpm install
```

The workspace packages share the compiler options in `tsconfig.base.json`:

| package | does | runtime dependencies |
| --- | --- | --- |
| `packages/cli` | the one command line, `anchorage-str-db scrape <airbnb\|licenses\|parcels>` | `airbnb-scraper`, `licenses-scraper`, `parcels-scraper`, `utils` |
| `packages/airbnb-scraper` | the Airbnb scrape over [airbnb-dlp](https://github.com/NickCrews/airbnb-dlp): decides what is fetched and stored, writes, checks | `db`, `airbnb-dlp`, `utils` |
| `packages/licenses-scraper` | the license scrape over `licenses-client` and `muni-gis-client`: chooses which license ids to read, geocodes, writes, checks | `db`, `licenses-client`, `muni-gis-client`, `utils` |
| `packages/parcels-scraper` | the parcel scrape from anchorage-property's published database: reads it, checks it, replaces `property_parcels` | `db`, `utils` |
| `packages/db` | the DuckDB schema (Drizzle), its migrations, the views, and the connection | `utils`, `@duckdb/node-api`, `drizzle-orm`, `@duckdbfan/drizzle-duckdb` |
| `packages/licenses-client` | fetches and parses the Muni's CityView license pages, and finds the newest license id | `utils` |
| `packages/muni-gis-client` | queries the Muni's ArcGIS services: feature layers, the address geocoder, community councils | `utils` |
| `packages/utils` | dates, logging, check results, concurrency, request pacing and retries, `fetch`, the Municipality boundary | none |
| `packages/ui` | the browser story and its estimates | |

Each source is split in two. A client works in memory: it returns typed
records and never touches DuckDB, so it can be tested and debugged without a
database. Airbnb's client is the airbnb-dlp package, maintained in its own
repository with its own tests and live checks against airbnb.com; the Muni's
are `licenses-client` and `muni-gis-client`. A `*-scraper` package
(`airbnb-scraper`, `licenses-scraper`, `parcels-scraper`) decides what is
stored, writes it and checks it; none imports another. `parcels-scraper` has
no client: DuckDB attaches anchorage-property's published file and copies its
rows directly.
`packages/cli` is the only entry point and holds no logic of its own.

Nothing is compiled. Each package exports its sources
(`"exports": {"./*": "./src/*.ts"}`, imported as
`@anchorage-str-db/utils/dates`), relative imports use their real `.ts`
extension, and Node strips the types when it runs them. For the same reason
`erasableSyntaxOnly` is on: no enums, namespaces, or parameter properties.
`pnpm typecheck` is the only type check.

## Running

```sh
pnpm scrape airbnb         # Airbnb; writes data/anchorage_str.duckdb
pnpm scrape airbnb --verbose --db /tmp/scratch.duckdb
pnpm scrape licenses       # the Muni's license pages, same database
pnpm scrape licenses --read-budget-seconds 60 --geocode-budget-seconds 30 --db /tmp/scratch.duckdb
pnpm scrape parcels        # anchorage-property's current parcels, same database
pnpm scrape parcels --verbose --db /tmp/scratch.duckdb
pnpm scrape --help         # every source's options
```

The default `--db` is resolved from the CLI's source file, so it is the repo's
`data/anchorage_str.duckdb` from any working directory.

An Airbnb run searches the Anchorage bounding box, keeps the listings inside the
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
`muni_license_`, `muni_address_` for the Muni's geocoder, and `property_`
for anchorage-property), so a new source gets a new prefix. Views have none.

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

To **rename** a column, hand-write the migration instead: drizzle-kit reads a
rename as a drop and an add, which would discard the archive.
`0001_ubiquitous_language.sql` is the worked example — `ALTER TABLE … RENAME
COLUMN` keeps each column's position, which `appendRows` depends on. Edit
`schema.ts` and `meta/<n>_snapshot.json` to match, add the `_journal.json`
entry, and cover it the way `connect.test.ts` covers 0001: seed a database
from `0000_baseline.sql` under the old names and assert the rows survive.

Views are SQL in `packages/db/src/views.ts`. They need no migration. To
**rename** one, add its old name to `DROPPED_VIEWS_SQL` there: `CREATE OR
REPLACE VIEW` cannot remove a view, so the published database would keep
answering queries under the old name from a definition nothing maintains.

### Dependencies

The only third-party runtime dependencies are `airbnb-dlp`,
`@duckdb/node-api`, `drizzle-orm` and `@duckdbfan/drizzle-duckdb`, which
adapts Drizzle's Postgres support to DuckDB.

airbnb-dlp is depended on as `^1`: each repair of an airbnb.com change is a
patch release, so keep the lockfile current to pick repairs up. When Airbnb
changes something, upgrading it is the first fix to try; report what remains
[upstream](https://github.com/NickCrews/airbnb-dlp/issues). ArcGIS Online,
the Muni's geocoder on `www.ancgis.com` and the CityView portal accept
Node's `fetch` (the geocoder refuses Python's default `User-Agent`).

Arguments are parsed with `node:util.parseArgs`. The license page parser
reads server-rendered HTML with regexes.

### Fetch everything, then write everything

`scrapeAirbnb` makes every network request (search, then a page and a calendar
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
lacks or reports unreliably: whether `location_lat`/`location_lng` is the
real position or jittered, the text under the map and whether Airbnb marks
the location verified, the municipal STR registration id, the primary host's
user id, listing type, building type, guest, bed, bedroom and bathroom
counts, and photos. All but photos are stored on the same `airbnb_listing_observations`
row as the search fields. When a page fetch fails, the `listings` view
carries the previous values forward.

The registration id is Anchorage's: `registrationId` in `airbnb.ts` reads
`STR` and its digits out of the host's "Registration Details" text, which
airbnb-dlp returns as written.

The pass has no flag to skip it. A skipped pass would write rows whose page
fields are carried forward from an earlier day, and nothing in the database
could tell those rows from freshly read ones. See
[`docs/research/airbnb-pdp-location-payload.md`](docs/research/airbnb-pdp-location-payload.md),
[`docs/research/airbnb-pdp-host-id.md`](docs/research/airbnb-pdp-host-id.md)
and [`docs/research/airbnb-pdp-listing-attributes.md`](docs/research/airbnb-pdp-listing-attributes.md).

### Price-quote pass

After the calendar pass, each run asks for the price of one stay per
listing: the first of airbnb-dlp's `bookableStays` checking in tomorrow or
later, which is the earliest bookable stay of the listing's minimum number
of nights (`fetchPriceQuotes` in `airbnb.ts`). A fully booked listing gets no
quote. The total and its breakdown are stored on the day's
`airbnb_listing_observations` row; a stay Airbnb will not quote keeps its
check-in and nights with a NULL total. Nightly rates are left to analysis. See
[`docs/research/airbnb-calendar-price.md`](docs/research/airbnb-calendar-price.md).

### First-review pass

Each run resolves the earliest review date of the listings that don't have one
yet, in search's order, until `FIRST_REVIEW_BUDGET_MS` (15 minutes) is spent,
and stores
it in `airbnb_listing_first_reviews`. The `listings` view derives
`first_available_date_est` from it. A listing is resolved once: a first
review never changes, and a listing with no reviews stores NULL and is not
fetched again, since a later first review would fall after its
`first_seen_date` and couldn't change the estimate. A failed fetch writes no
row, so the listing is retried next run.

Airbnb's reviews sort newest first, so the pass reads every review of each
listing (`fetchFirstReviews` in `airbnb.ts`), one request per page of
reviews. A cheaper way to reach the oldest review is
[NickCrews/airbnb-dlp#43](https://github.com/NickCrews/airbnb-dlp/issues/43).
Only each review's `createdAt` is used; no review text or reviewer data is
kept.

The pass is time-budgeted, so a backfill spans several runs and adds at most
15 minutes to one. Its `first_review_failure_rate` check is a warning: a failure is
retried next run, and failing the run would withhold that day's calendar and
listings, which can't be scraped after the fact.

### Host pass

Every listing page carries its primary host's profile card (name, bio,
`timeAsHost`), so the host pass makes no requests. airbnb-dlp drops a card
that names another account than the page's host. `collectHostCards` reduces
the run's pages to one card per distinct host (about 2 listings per host),
taking the lowest listing id's reading when they differ, so a re-run records
the same thing. `recordHostObservations` writes a row for every host with a
listing observed that day, including hosts whose only page failed.

### Request budget

A run makes about `3N` requests for N listings, a page, a calendar and a
price quote each (the host pass adds none), plus search's, which airbnb-dlp
splits by price and area until no query hits Airbnb's result cap. At ~2600
listings that is ~8000 requests. The first-review pass adds a request per
page of reviews of each unresolved listing, up to its 15-minute budget.

One airbnb-dlp client paces every request of a run. Its pace adapts to
Airbnb: it speeds up while requests are served normally, and a 429 halves it
and pauses every request for as long as Airbnb asks. If Airbnb keeps
rate-limiting or refuses the client, airbnb-dlp ends the call as `Blocked`
and the run aborts. A single listing's failure is counted, and the
failure-rate checks judge them in aggregate.

## The license scrape

`pnpm scrape licenses` (`packages/licenses-scraper/src/scrape.ts`) records
every license the Muni's CityView portal publishes: Short-Term Rentals, Business and Alcohol
licenses, read from their license pages by id. It is a separate app and
workflow from the Airbnb scrape, with its own transaction, run log
(`muni_license_scrape_runs`) and checks, so an outage at either source leaves the
other's day intact. A scrape reads license pages for up to 75 minutes, then
geocodes addresses for up to 10 minutes; `licenses.yml` sets both budgets
beside its timeout (see the
[license scraper README](packages/licenses-scraper/README.md#budget)).
Pages are read one at a time at up to 1/s. A 429 from the portal halves the
request rate and the read is retried after a wait; the rate climbs back after
a run of successes. See
[`packages/licenses-client/README.md`](packages/licenses-client/README.md#pacing).

License ids are one counter across every license type, and most ids are
hidden license ids. The read history is the scrape's state: each scrape finds
the newest id from the License Locator, then reads new ids, never-read ids,
and ids whose latest read is due, in the order `chooseLicenseIds` documents
([`packages/licenses-scraper/README.md`](packages/licenses-scraper/README.md)). A failed
read writes nothing and is retried next scrape.

The license page is the only source for the licensee's own description of
the business, the parcel id, and every certificate issued under the license.
The `licenses` view holds each license's latest read, and `registrations`
one row per STR Certificate number on a Short-Term Rentals license.

After the page reads are written, the scrape's geocoding pass sends each new
license address to the Muni's geocoder (at most 1000 a scrape) and stores
the match and the community council containing it in
`muni_address_geocodes`. It makes its requests first and writes in its own transaction, so a failure
in it leaves the page reads written. An address with no match is asked about
again after 90 days. See
[`packages/licenses-scraper/README.md`](packages/licenses-scraper/README.md).

The Municipal Clerk's ArcGIS registration layer answers only with a token.
What it published is kept in `muni_str_registration_observations` and
`muni_str_registry_runs`, which nothing writes. `registrations` takes the
submitted date from it, its parcel type where the license's parcel is not in
`property_parcels`, and its geocoded coordinate and community council where
the license's own address has no match; it keeps the registrations only the
layer holds, as not active. What the Muni
published there, and how it is cleaned:

- `BusinessName` is the string `'None'` when none was given. Stored as
  published; `registrations.business_name` is NULL.
- A `Location` the Muni's geocoder couldn't match has `GeocodedAddress`
  `'Incomplete address provided. No Match.'` and the placeholder coordinate
  (-150.20935, 61.153442). Stored as published; `registrations.geocoded_lat`/`lng`
  are NULL.

## The parcel scrape

`pnpm scrape parcels` (`packages/parcels-scraper/src/scrape.ts`) copies the
current parcels from [anchorage-property](https://github.com/NickCrews/anchorage-property),
which reads the Muni's parcel layer daily and keeps each parcel's history,
into `property_parcels`. Nothing in this repo scrapes parcels. DuckDB
attaches anchorage-property's published `anchorage-current.duckdb` read-only
over HTTPS and reads only the columns the table takes, about 98,500 rows.

The scrape reads the source into a temporary table, checks it, then replaces
the whole table and logs the run in `property_parcel_scrape_runs` in one
transaction. A source with fewer than 90,000 parcels, a duplicate or missing
`parcel_id`, or a missing column fails a check and leaves the table as it
was. The table holds the current snapshot only; history stays in
anchorage-property. `licenses` joins it on `parcel_id` for
`parcel__property_type` (the parcel's `property_type`: `RESIDENTIAL`,
`CONDO`, ...) and `parcel__total_living_units`, and `registrations` takes
`parcel_type` from it,
falling back to the archived layer's `Residential`/`Commercial`. See
[`packages/parcels-scraper/README.md`](packages/parcels-scraper/README.md).

## Inspecting the database

```sh
duckdb data/anchorage_str.duckdb
```

or run queries from [`docs/policy_questions.sql`](docs/policy_questions.sql).

## CI

Each upstream source has its own workflow, schedule and outage issue, so a
broken source stops only its own updates:

| workflow | source | runs (UTC) | outage issue |
| --- | --- | --- | --- |
| [`licenses.yml`](.github/workflows/licenses.yml) | the Muni's CityView license pages (`pnpm scrape licenses`) | 08:00 | License scrape is failing |
| [`airbnb.yml`](.github/workflows/airbnb.yml) | Airbnb (`pnpm scrape airbnb`) | 12:00 | Airbnb scrape is failing |
| [`parcels.yml`](.github/workflows/parcels.yml) | anchorage-property's current parcels (`pnpm scrape parcels`) | 16:00 | Parcel scrape is failing |

Each first runs `pnpm typecheck` on `packages/cli` and the packages it
imports, so a type error fails before any request.

All three write the one database. Runners are ephemeral, so each run
downloads it from the `latest-data` release, writes its own tables, and
re-uploads it if its checks pass. They share the concurrency group
`db-write`, so one waits for another rather than uploading over its writes.
GitHub keeps only one pending run per group and cancels the older one, so
the schedules are spread to keep a run from waiting behind another; a manual
dispatch while one source is running and another is queued cancels the
queued one.

Publishing is separate from fetching:

- [`pages.yml`](.github/workflows/pages.yml) rebuilds the viewer with the
  `latest-data` database after any source workflow succeeds, and on every
  push to `main`. The Overview's "Last fetched" card reads the
  `source_freshness` view, which has each source's latest successful run.
- [`backup.yml`](.github/workflows/backup.yml) runs daily at 06:00 UTC and
  copies `latest-data` to a `backup-YYYY-MM-DD` release when the newest
  backup is 7 or more days old; a manual run always makes one. The rule keys
  on the newest backup, not the weekday, so a failed backup is retried the
  next day. It only reads `latest-data`, so it is not in `db-write`.

Backups are kept indefinitely. At ~45 MB each (November 2026) that is ~2.3
GB a year. GitHub puts no cap on total release storage, only 2 GiB per asset,
and an old backup is often the only copy of history from before a breaking
schema change. Revisit if the asset grows past a few hundred MB.

A failed run opens its workflow's outage issue ("Weekly database backup is
failing" for backups), labelled `cron-down`, or comments on it if it is
already open; the next successful run of the same workflow closes it. Every
scheduled workflow uses the one label, and the title tells their issues
apart. If `latest-data` has no database, each source workflow fails unless
dispatched with `start_fresh=true`.

The steps the workflows share are composite actions in `.github/actions/`:
`restore-db` (download from `latest-data`), `publish-db` (upload to it) and
`outage-issue` (open or close the workflow's outage issue).

The workflows need no secrets; `gh` uses the automatic `GITHUB_TOKEN`.

### When the published database has an incompatible schema

Every run fails with `LegacySchemaError` until someone:

1. Copies the `latest-data` asset to its own release, named for the schema
   it holds (e.g. `archive-<date>`).
2. Deletes it: `gh release delete-asset latest-data anchorage_str.duckdb`
3. Starts over: `gh workflow run airbnb.yml -f start_fresh=true`

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
- **Portfolio size is counts, not a classification.** `host_listing_portfolios` is
  derived from `airbnb_listing_observations.host_id` with no extra requests, as a
  time series. Where an owner ends and an operator begins is left to
  downstream users, so no threshold is stored; the viewer's cutoff is a
  labelled display choice. It counts only listings inside the Municipality,
  so it is an Anchorage listing portfolio and undercounts a host who also
  lists elsewhere (issue #34).
- **Listings are never UPDATEd.** `first_seen_date`, `last_seen_date` and
  `page_seen_date` are derived from observations, so they stay correct for a
  listing that retires and later relists, and a bug in version logic is
  fixed by editing a view. This matters because the published `.duckdb` is
  the only copy of the archive.
- **Retirement is a view predicate.** A listing is active if seen within
  `RETIREMENT_GRACE_DAYS` (5) of the latest completed run, because search
  results occasionally omit a listing for a day. "Latest completed run" is
  the later of `max(scrape_date)` in the observations and in `airbnb_scrape_runs`
  where `listings_seen IS NOT NULL`: the first alone stops advancing on a day
  with no listings, and the second alone would let a failed run retire every
  listing.
- **A community council is found when an address is geocoded, not in SQL.**
  The geocoding pass fetches the council polygons each scrape it geocodes
  anything and stores each match's council on its row. Storing the polygons
  and joining in SQL would need DuckDB's spatial extension in every reader
  of the published file, including the browser viewer, for a value that
  only changes when an address is first geocoded.
- **Estimates live in the viewer, not the database.** Revenue, occupancy and
  booked-or-blocked are interpretations of the calendar and quotes, with
  tunable rules (`BLOCK_RUN_NIGHTS`). `packages/ui/src/model/estimates.ts`
  builds them in the browser from the published tables, so changing a rule
  needs no migration and the database keeps only what the sources said.
- **Licenses are stored raw, and joined to listings in views.**
  `muni_license_page_reads` and the archived
  `muni_str_registration_observations` hold what the Muni publishes, with its
  field values unchanged. `licenses` derives one row per license and
  `registrations` one row per registration from them, and `listings_active_with_registration` joins Airbnb listings on
  `registration_id`, so a cleaning or join rule is fixed by editing a
  view. A license page read is a whole page, stored every time it is read,
  like `airbnb_listing_observations`, rather than change-only: the reads give
  exact first- and last-read dates.
- **Read `calendar_current`, not `airbnb_calendar_status`.** An inactive
  listing's calendar is no longer fetched, so its future nights stay
  `is_current` in the raw table for up to twelve months. `calendar_current` drops nights after
  the listing's last sighting and keeps the ones before it.
- **Undated search.** `searchMunicipality` sends no check-in/check-out, so
  Airbnb returns every listing in the area rather than only those free on
  given nights. Availability comes from the calendar.
- **Calendar days before the scrape date are dropped.** Airbnb's calendar
  starts on the 1st of the current month and marks elapsed days
  `available: false`. `nightsFrom(calendar, minDate)` filters them so they
  don't read as bookings.
- **A listing's address comes from its registration, not its coordinate.**
  A listing showing a registration id gets the registration's address and
  parcel in `listings_active_with_registration`; nothing matches the rest by
  location. Before adding that, read
  [`docs/research/airbnb-address-deanonymization.md`](docs/research/airbnb-address-deanonymization.md).
- **Bed, bedroom and bathroom counts, and listing type, come from the listing
  page, not search.** Search cards show them only as free text, carry no
  guest line, and drop the bath line on some days, which would open a
  spurious version each time.
- **Bedrooms and bathrooms are stored as Airbnb writes them.** They exist
  only as display text (`Studio`, `Shared bathroom`), so they are stored
  verbatim rather than as counts: a new wording can't be misread, and
  analysis can re-derive anything from the original. Listing type is
  airbnb-dlp's `roomType` (`entire_home`, `private_room`, `shared_room`,
  `hotel_room`), a closed set that is NULL for a value airbnb-dlp does not
  know; `listing_type_coverage` fails the run when that happens often
  ([NickCrews/airbnb-dlp#45](https://github.com/NickCrews/airbnb-dlp/issues/45)).
  Guest capacity and beds are integers in Airbnb's data and are stored as
  such.
- **Closed sets live in one place.** `packages/utils/src/airbnbValues.ts` holds
  `LISTING_TYPES` and `BUILDING_TYPES`. The schema types the columns from
  them, the scraper and the UI take their values from them, SQL built as a
  string checks its literals against them
  (`sqlLiteral('entire_home' satisfies ListingType)`, with `utils/src/sql.ts`), and the `listing_type_known` and
  `building_type_known` checks fail a run that stored anything else.
  `airbnb.ts` fails to compile if airbnb-dlp's room types and
  `LISTING_TYPES` differ. A building type outside the set is stored as NULL
  with a warning; add it to `BUILDING_TYPES` to keep it.
- **The Municipality boundary is generated from the Muni's community council
  polygons.** `utils/src/muni_geography/municipality.sql` builds
  `municipality.geojson` and explains the 1 km padding; rerun it rather than
  editing the GeoJSON by hand. The Airbnb search covers the boundary's
  bounding box (`MUNICIPALITY_BOUNDING_BOX`).

## Adding Vrbo

Not implemented. Vrbo's anti-scraping measures are stronger than Airbnb's,
so start by investigating what is reachable. Then:

- Add a Vrbo client that works in memory, like airbnb-dlp; a
  `packages/vrbo-scraper/` that stores it; and a `vrbo` source in
  `packages/cli`.
- Add a `source` column (default `'airbnb'`) to `airbnb_listing_observations` and
  `airbnb_calendar_status`, and change the views' `PARTITION BY listing_id` to
  `PARTITION BY source, listing_id`, since listing ids are unique only per
  source.
- Most queries in `docs/policy_questions.sql` then need only a
  `GROUP BY source`.

## Tests

```sh
pnpm test        # vitest, every package
pnpm typecheck
```

- Parsing Airbnb is airbnb-dlp's, and tested there.
  `airbnb-scraper/test/e2e/scrape.test.ts` replays a recorded live scrape of
  a few Midtown blocks through the whole pipeline, checks included;
  `test/e2e/record.ts` re-records it.
- `licenses-client/test/licensePage.test.ts` reads real license pages from the
  Muni's portal, one per markup case the parser handles (listed in that
  package's README), so it fails when the portal's markup changes.
- `muni-gis-client/test/geocoder.test.ts` and `councils.test.ts` test parsing,
  matching and council lookup offline, then ask the live geocoder and
  council layer.
- `airbnb-scraper/test/store.test.ts` and `registrations.test.ts`, and
  `db/test/registrations.test.ts`, run the merge logic and views against a
  real DuckDB file, and `licenses-scraper/test/scrape.test.ts` runs a license
  scrape, geocoding pass included, against one with injected page reads and
  GIS services. `licenses-scraper/test/select.test.ts` covers which ids a
  scrape reads.
- `parcels-scraper/test/scrape.test.ts` scrapes a local DuckDB file shaped like
  anchorage-property's, offline: `scrapeParcels` takes the source as `sourceUrl`.
- `db/test/connect.test.ts` checks that migrations apply once and that an
  incompatible file is rejected; `database.test.ts` checks how `appendRows`
  converts values; `sourceFreshness.test.ts` covers `source_freshness`.

Only `licenses-client/test/licensePage.test.ts` and the live tests in
`muni-gis-client` need the network. Fetching is injected: `scrapeAirbnb`
takes an airbnb-dlp `client`, `fetchLayer` and `fetchCommunityCouncils` take a `fetchJson`,
`fetchLicensePages` takes a `fetchOne`, `geocodeAddresses` takes a
`geocodeOne`, and `scrapeLicenses` takes all of the license scrape's. The `live*`
functions are the only places real requests are made.

When Airbnb changes something, the failure-rate and `*_coverage` checks fail
the run. Upgrade airbnb-dlp first; to debug further, run `test/e2e/record.ts`,
which scrapes a small box live.
