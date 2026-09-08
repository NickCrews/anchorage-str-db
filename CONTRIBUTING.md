# Contributing / operating the pipeline

## Setup

```sh
uv sync
```

## Running it

```sh
uv run anchorage-str-db --db data/anchorage_str.duckdb daily
```

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

### Two phases: fetch everything, then write everything

`run_daily` is deliberately split. All the network work happens first —
search, then a page per listing, then a calendar per listing — and nothing
touches the database until every fetch has returned. Then all the writes go
in inside a single `store.transaction`.

This matters because DuckDB's Python client autocommits every statement. Left
alone, a run that died in the calendar pass (the longest phase, and the one
that gets rate-limited) would leave today's listings and observations
committed with no calendar rows, and nothing in the schema marks a scrape
date as partial — so every query would read that day as complete. Worse,
`merge_listings` closes old SCD2 versions and inserts their replacements as
two separate statements, so a crash in between drops listings out of
`is_current` with nothing taking their place, under a listing-count check
whose band is wide enough not to notice.

A scrape date is the unit that carries meaning here: every table is keyed by
it, and the gate judges one. So a run either records a whole day or records
none of it. The failed-run row in `scrape_runs` is written *after* the
rollback, on purpose — inside the transaction it would roll back along with
the run it documents.

The network passes stay outside the transaction because they take minutes,
and there is nothing to be gained by holding a write lock through them.
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

One run makes roughly `2N + 8` requests for N listings — a page and a
calendar each, plus the search's paginated `StaysSearch` calls. Airbnb's web
API key is scraped once per run and threaded through every calendar request
(`airbnb_client.get_api_key`). Don't drop that argument: `pyairbnb`'s
`get_calendar` silently fetches its own key when it isn't given one, and it
does so *per call*, which means every listing re-downloads the ~600 KB
homepage to re-extract the same constant. That alone was two thirds of the
run's requests before it was hoisted.

## Inspecting the database

```sh
duckdb data/anchorage_str.duckdb
```

or run anything in [`queries/policy_questions.sql`](queries/policy_questions.sql).

## How CI runs this

[`.github/workflows/daily.yml`](.github/workflows/daily.yml) runs the exact
same `uv run anchorage-str-db daily` command once a day. Since GitHub Actions
runners are ephemeral, each run downloads the previous day's database from
the `latest-data` release (that's the persistence mechanism — there's no
separate cloud database), scrapes, merges, and re-uploads it if the quality
gate passes. A `backup-YYYY-MM-DD` release is cut weekly and kept
indefinitely, so a bad `latest-data` overwrite is always recoverable.

No secrets are required — `gh release` inside the workflow uses the
automatic `GITHUB_TOKEN`.

## Design choices worth knowing before changing things

- **SCD2, not snapshot-per-day.** Both `listings` and `calendar_status` only
  grow a new version when something changes (via `attr_hash` /
  `status_hash`). A naive daily snapshot of ~250 listings × ~365 forward
  nights would be ~90k rows/day, ~33M rows/year, almost all of it
  unchanged nights re-written for no reason. Change-only merging keeps the
  archive's size proportional to real market activity.
- **`last_seen_date` is separate from SCD2 version validity**, specifically
  so a listing that misses one day of search results (Airbnb's pagination
  is not perfectly reliable) doesn't get spuriously retired. Retirement
  only fires after `RETIREMENT_GRACE_DAYS` (5) consecutive misses — see
  `config.py`.
- **Undated search.** `search_anchorage()` passes no check-in/check-out —
  Airbnb's map search without dates returns every listing it will show for
  the area, not just ones free on specific nights. Nightly availability is
  a separate, per-listing concern (the calendar), not something to encode
  into the search itself.
- **Calendar days before the scrape's own date are dropped.** Airbnb's
  calendar endpoint always returns the *whole* current month starting on
  the 1st, so a scrape on the 15th still gets days 1–14 back marked
  `available: false` — not because anyone booked them, just because the
  past can't be booked. `fetch_calendars(min_date=...)` filters those out;
  without it every day before a given run looks like 100% occupancy, which
  is a UI artifact, not a real signal. Caught by eyeballing the first real
  run's output, not by a test — if you touch calendar parsing, sanity-check
  a few days' worth of output against the live site before trusting it.
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
  averages it out.
- **The listing-page parse is layered on purpose, and the layers are
  recorded.** `listing_page.py` extracts the same facts three independent
  ways — schema.org JSON-LD, a shape-search over the embedded GraphQL
  state, and regexes over the raw HTML — because none of it is a documented
  API. Each page records which layers actually contributed
  (`ListingPage.location_source`, in memory, not a database column), and
  the `extraction_layer_*_alive` checks fail when one stops, so a silent
  degradation shows up in the quality gate instead of as quietly missing
  data. Don't "simplify" it to a single path.
- **The bbox is derived, not eyeballed** — see the docstring in
  `config.py`. If Anchorage's boundaries or parcel coverage change, or you
  want tighter/looser padding, recompute it from `anchorage-property`
  rather than hand-editing the coordinates.

## Adding a second source (Vrbo)

Not done yet. Vrbo/Expedia Group has a real presence in ski towns and
would be worth adding, but their anti-scraping posture is stronger than
Airbnb's map-search API and there's no equivalent well-maintained open
library to build on the way `pyairbnb` exists for Airbnb — it would need
its own investigation into what's scrapeable and how. If you pick this up:

- Give it its own `vrbo_client.py`, mirroring `airbnb_client.py`'s shape
  (a search function, a calendar function).
- Add a `source` column to `listings` and `calendar_status` (defaulting
  to `'airbnb'`) so the two sources coexist in one schema instead of
  needing parallel tables.
- The policy questions in `queries/policy_questions.sql` should mostly just
  need `GROUP BY source` added, not a rewrite.

## Tests

```sh
uv run pytest
```

`tests/test_listing_page.py` parses synthetic copies of Airbnb's embedded
PDP JSON — it can't tell you Airbnb hasn't changed that shape (only a live
fetch can), but it will fail if someone flattens the path-walking.
`tests/test_store.py` exercises the SCD2 merge logic (listings, calendar,
retirement) against a real in-memory-ish DuckDB file with synthetic data —
no network access needed. There's currently no test that hits the live
Airbnb API (by design — CI shouldn't depend on it being reachable/unblocked
to pass); `airbnb_client.py` and `parse.py` are the modules most likely to
break silently when Airbnb changes something, so if you're debugging a
production failure, start by re-running `search_anchorage()` and
`fetch_calendars()` interactively against a couple of known room IDs.
