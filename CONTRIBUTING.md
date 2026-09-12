# Contributing / operating the pipeline

## Setup

```sh
pnpm install
```

A pnpm workspace with two packages — `packages/scraper` and `packages/ui` —
sharing the compiler options in `tsconfig.base.json`.

Relative imports are written with their real `.ts` extension, which is what
lets `node src/cli.ts` run the sources directly (Node strips the types) while
`tsc` rewrites the extension to `.js` on the way into `dist/`. One spelling,
and no build step needed to try something out. The corollary is
`erasableSyntaxOnly`: no enums, no namespaces, no parameter properties,
because none of those survive type erasure.

## Running it

```sh
pnpm daily                 # the whole pipeline, into data/anchorage_str.duckdb
pnpm daily --verbose --db /tmp/scratch.duckdb
```

Run it from the repo root — that is what the root `daily` script is for. It
invokes `packages/scraper/src/cli.ts` directly rather than going through
`pnpm --filter`, which would set the working directory to the package and
quietly resolve the default `--db` to `packages/scraper/data/`.

That's the entire pipeline: search the Anchorage bbox, fetch every listing's
page and calendar, SCD2-merge all of it into the database, run the
data-quality gate. Non-zero exit means an error-severity check failed — see
the log for which one. `--verbose` logs every check's pass/fail, not just
failures.

A run against a fresh (empty) database creates the schema automatically.
There is no migration machinery: schema changes mean editing
`store.SCHEMA_SQL` and rebuilding the database from scratch. Once there's
published history worth keeping, that stops being true and this repo will
need a real answer — until then, don't add one speculatively.

### Two dependencies

The scraper depends on `impit` and `@duckdb/node-api`, and nothing else.

`impit` is the load-bearing one. Airbnb sits behind Akamai, which
fingerprints the TLS ClientHello; Node's built-in `fetch` announces itself as
Node however you set `User-Agent`, and is refused. `impit` replays a real
Chrome handshake, which is why `src/airbnb/http.ts` asks for `chrome124`. If
requests start failing wholesale with a 403, check that first: the browser
profile eventually ages out of plausibility.

Everything else is the standard library. Argument parsing is
`node:util.parseArgs`; the HTML the listing-page parser reads is script tags
pulled out with a regex, because nothing in it traverses a DOM (see
`src/html.ts`).

Airbnb's three endpoints are implemented in `packages/scraper/src/airbnb/`,
one file each. That directory's README covers them.

### Two phases: fetch everything, then write everything

`runDaily` is deliberately split. All the network work happens first —
search, then a page per listing, then a calendar per listing — and nothing
touches the database until every fetch has returned. Then all the writes go
in inside a single `db.transaction`.

This matters because DuckDB autocommits every statement. Left
alone, a run that died in the calendar pass (the longest phase, and the one
that gets rate-limited) would leave today's listings and observations
committed with no calendar rows, and nothing in the schema marks a scrape
date as partial — so every query would read that day as complete. Worse,
`recordObservations` deletes a scrape date's rows before re-inserting them
(so a re-run replaces a day rather than doubling it), and a crash in between
would drop the day entirely, under a listing-count check whose band is wide
enough not to notice.

A scrape date is the unit that carries meaning here: every table is keyed by
it, and the gate judges one. So a run either records a whole day or records
none of it. The failed-run row in `scrape_runs` is written *after* the
rollback, on purpose — inside the transaction it would roll back along with
the run it documents.

The network passes stay outside the transaction because they take over an
hour, and there is nothing to be gained by holding a write lock through
them.
Individual per-listing failures are tolerated rather than fatal — a failed
page or calendar fetch comes back marked with an error and is judged in
aggregate by the failure-rate checks. Tolerate per listing, judge per day,
commit per day.

### The listing-page pass

Every run makes a second per-listing pass that fetches each listing's own
page for two things the search endpoint doesn't carry: Airbnb's
`isExactLocation` flag — which says whether the `(location_lat,
location_lng)` we store is the listing's real position or its privacy
jitter — and the municipal STR registration number. Results land on
`listings` itself, in the same SCD2 version as the search fields they
describe; where a page fetch fails for a given listing, the previous
version's values are carried forward rather than blanked, so a flaky fetch
doesn't churn the history.

It adds a request per listing, and it is deliberately not behind a flag. A
run that skipped it would still write a full set of rows,
whose location and registration fields were yesterday's carried forward —
a second, quieter kind of daily record that nothing reading the database
can tell apart from the real one. One invocation, one meaning. See
[`docs/research/airbnb-pdp-location-payload.md`](docs/research/airbnb-pdp-location-payload.md)
for what the pass measured and why it's worth the requests.

### Request budget

One run makes roughly `2N + 200` requests for N listings — a page and a
calendar each, plus one `StaysSearch` request per price band. The search is
many requests and never paginates; see
[`docs/research/airbnb-search-pagination.md`](docs/research/airbnb-search-pagination.md)
if you need to know why. At today's ~2600 listings that is ~5400 requests,
and a run takes about 50 minutes — the per-listing passes dominate, so they
are the knobs to reach for if a run needs to be shorter.

Airbnb's web API key is scraped once per run (`pipeline.ts`) and threaded
through every search and calendar request as a required argument. It is a
long-lived public constant, not a session token, so one fetch covers the run
— and it has no default on purpose, because a per-call fetch would make every
listing re-download the same ~600 KB homepage to re-extract the same string,
which is two thirds of a run's requests.

The budget itself lives in `pace.ts`, and the attempt loop all three passes
share lives in `retry.ts` — which is where the three kinds of failure are
told apart: a 429 aborts the run immediately, a run of timeouts halves the
request rate, and anything else is Airbnb's ordinary intermittent 5xx and is
worth another try.

## Inspecting the database

```sh
duckdb data/anchorage_str.duckdb
```

or run anything in [`docs/policy_questions.sql`](docs/policy_questions.sql).

## How CI runs this

[`.github/workflows/daily.yml`](.github/workflows/daily.yml) runs the exact
same pipeline once a day, from a `tsc` build of `packages/scraper`. Since GitHub Actions
runners are ephemeral, each run downloads the previous day's database from
the `latest-data` release (that's the persistence mechanism — there's no
separate cloud database), scrapes, merges, and re-uploads it if the quality
gate passes. A `backup-YYYY-MM-DD` release is cut every Sunday and kept
indefinitely.

A failed run opens a `pipeline-down` issue, and the next successful run
closes it. If `latest-data` has no database, the run fails unless it is
dispatched with `start_fresh=true`.

No secrets are required — `gh` inside the workflow uses the automatic
`GITHUB_TOKEN`.

### When the published database becomes unreadable

After a breaking schema change, every run fails with `LegacySchemaError`
until someone:

1. Archives the `latest-data` asset on its own release, named for the
   schema it holds (e.g. `archive-<date>`).
2. Deletes it: `gh release delete-asset latest-data anchorage_str.duckdb`
3. Starts over: `gh workflow run daily.yml -f start_fresh=true`

## Design choices worth knowing before changing things

- **SCD2 for the calendar, snapshot-per-day for listings.** The two tables
  differ by a factor of ~400 in how much a daily snapshot costs, so they
  are stored differently:
  - `calendar_status` is change-only (via `status_hash`). A snapshot of
    ~2600 listings × ~365 forward nights is ~950k rows/day, ~350M rows/year,
    almost all of it unchanged nights re-written for no reason. The merge
    logic earns its keep.
  - `listing_observations` is one row per listing per day — ~2600 rows/day,
    ~950k rows/year of the most compressible data imaginable. Change-only
    merging buys nothing at that size, so `listings` is a **view**:
    `listing_versions` runs gaps-and-islands over the daily rows to rebuild
    `valid_from`/`valid_to`, and `listing_activity` derives the
    first/last/page-seen dates.
- **Don't add a column to `listings` — add it to `listing_observations`.**
  The observations are the only stored facts about a listing; everything
  else is derived. If the new column should open a new version when it
  changes, add it to `VERSION_KEY_SQL` in `store.ts` too. If it moves
  most days (a price, a review count), leave it out of the key so a new
  review doesn't read as a new listing.
- **Nothing about a listing is ever UPDATE'd.** `first_seen_date`,
  `last_seen_date` and `page_seen_date` are derived from the observations
  that imply them, so they cannot disagree with them — the case that breaks
  a hand-maintained column is a listing that retires and later relists.
  Deriving also means a bug in the version logic is fixed by editing a view,
  which matters because the published `.duckdb` is downloaded, mutated and
  re-uploaded every run, and is the only copy of the archive.
- **Retirement is a view predicate, not a write.** A listing is current if
  it has been seen within `RETIREMENT_GRACE_DAYS` (5) of the latest
  completed run. The grace exists because Airbnb's map search paginates
  unreliably and a listing blinking out for a day shouldn't read as "this
  STR closed." "Latest completed run" deliberately means the later of
  `max(scrape_date)` in the observations and in `scrape_runs` where
  `listings_seen IS NOT NULL`: the first alone would freeze the clock on
  the day every listing vanished, and the second alone would let a *failed*
  run (all counts NULL) retire the entire inventory.
- **Read `calendar_current`, not `calendar_status`.** When a listing is
  retired we stop fetching its calendar, so its forward nights freeze with
  `is_current = true` and the raw table goes on reporting them as operating
  for up to twelve months. `calendar_current` cuts by night rather than by
  listing — a retired listing keeps the nights it was actually observed
  operating for, which is genuine realized occupancy, and loses the
  unconfirmed future.
- **Undated search.** `searchAnchorage` passes no check-in/check-out —
  Airbnb's map search without dates returns every listing it will show for
  the area, not just ones free on specific nights. Nightly availability is
  a separate, per-listing concern (the calendar), not something to encode
  into the search itself.
- **Calendar days before the scrape's own date are dropped.** Airbnb's
  calendar endpoint always returns the *whole* current month starting on
  the 1st, so a scrape on the 15th still gets days 1–14 back marked
  `available: false` — not because anyone booked them, just because the
  past can't be booked. `toNights(days, minDate)` filters those out;
  without it every day before a given run looks like 100% occupancy, which
  is a UI artifact, not a real signal. The unit test pins the filter but not
  Airbnb's response shape, so if you touch calendar parsing, sanity-check a
  few days' worth of output against the live site before trusting it.
- **Half the coordinates in `listings` are fake, and `location_is_exact`
  says which half.** Airbnb jitters the map pin unless the host opted into
  showing the exact spot. Any query that joins
  `location_lat`/`location_lng` to parcels,
  addresses, or anything else spatial should filter on that column first —
  otherwise it's matching Airbnb's random offset to whatever parcel is
  nearby and reporting it as an address. The flag lives on `listings`
  rather than in a table of its own precisely so that filter is one column
  away from the coordinate instead of one join away. The jitter is stable
  per listing (verified by repeated fetching), so no amount of re-scraping
  averages it out. `location_exact_address` is the escape hatch and it is
  null for most listings — we store the address when Airbnb hands us one and
  make no attempt to infer the rest. That's a deliberate deferral recorded in
  the PRD's follow-ups, not an oversight: don't add a geocoding or
  parcel-matching step without reading
  [`docs/research/airbnb-address-deanonymization.md`](docs/research/airbnb-address-deanonymization.md)
  first, which concludes the tractable path is a public-records request to
  the Municipality rather than anything technical.
- **The listing-page parse is layered on purpose, and the layers are
  recorded.** `listingPage.ts` extracts the same facts three independent
  ways — schema.org JSON-LD, a shape-search over the embedded GraphQL
  state, and regexes over the raw HTML — because none of it is a documented
  API. Each page records which layers actually contributed
  (`ListingPage.locationSource`, in memory, not a database column), and
  the `extraction_layer_*_alive` checks fail when one stops, so a silent
  degradation shows up in the quality gate instead of as quietly missing
  data. Don't "simplify" it to a single path.
- **The bbox is derived, not eyeballed** — see the docstring in
  `config.ts`. If Anchorage's boundaries or parcel coverage change, or you
  want tighter/looser padding, recompute it from `anchorage-property`
  rather than hand-editing the coordinates.

## Adding a second source (Vrbo)

Not done yet. Vrbo/Expedia Group has a real presence in ski towns and would
be worth adding, but their anti-scraping posture is stronger than Airbnb's
map-search API, so it needs its own investigation into what is reachable and
how before any of the below is worth writing. If you pick this up:

- Give it its own `src/vrbo/` directory, mirroring `src/airbnb/`'s shape
  (one file per endpoint, and a standardizer for each response).
- Add a `source` column to `listing_observations` and `calendar_status`
  (defaulting to `'airbnb'`) so the two sources coexist in one schema
  instead of needing parallel tables. `listings` picks it up for free, but
  the views' `PARTITION BY listing_id` clauses need to become
  `PARTITION BY source, listing_id` — room ids are only unique per source.
- The policy questions in `docs/policy_questions.sql` should mostly just
  need `GROUP BY source` added, not a rewrite.

## Tests

```sh
pnpm test        # vitest, both packages
pnpm typecheck
```

`test/listingPage.test.ts` parses synthetic copies of Airbnb's embedded PDP
JSON — it can't tell you Airbnb hasn't changed that shape (only a live fetch
can), but it will fail if someone flattens the path-walking.
`test/standardize.test.ts` does the same for the search response.
`test/store.test.ts` exercises the SCD2 merge logic (listings, calendar,
retirement) against a real DuckDB file with synthetic data.

Nothing in the suite touches the network, by design — CI shouldn't depend on
Airbnb being reachable and unblocked to pass. That is bought by keeping the
fetching behind an injected function: `searchAnchorage` takes a `fetchPage`,
`fetchCalendars` takes a `fetchOne`, and `liveSearchFetcher` /
`liveCalendarFetcher` / `livePageFetcher` are the only places a real request
is made. Tests pass a stub; the pipeline passes the live one.

The corollary is that `src/airbnb/` and `parse.ts` are the code most likely
to break silently when Airbnb changes something, because no offline test can
see it. If you're debugging a production failure, start there: run a
`searchAnchorage` over a small box and a `livePageFetcher` against a couple
of known room ids, and check what the quality gate said about
`extraction_layer_*_alive` — those checks exist precisely because a parse
degrading to nulls otherwise looks like a quiet, healthy run.
