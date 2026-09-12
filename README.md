# Anchorage STR Database

Work in progress!

A daily record of Airbnb short-term rentals (STRs) in the Municipality of
Anchorage, Alaska, for answering questions like:

- How many listings are there, how many are active?
- What is the character of these rentals: number of rooms, price, operated by on-premise property owner vs someone with many listings
- How has that changed over time? How does it vary between neighborhoods, price bands, size, room type, etc?

## What you get

- One DuckDB file, `anchorage_str.duckdb`, with daily snapshots of listings
  and calendar availability
- Policy queries in `docs/policy_questions.sql`
- A browser viewer in `packages/ui/`

## Quick start

```sh
gh release download latest-data --repo <owner>/anchorage-str-db -O anchorage_str.duckdb
duckdb anchorage_str.duckdb
```

```sql
SELECT count(*) FROM listings WHERE is_current;
```

## Daily run

From the repo root:

```sh
pnpm install
pnpm daily
```

This searches the Anchorage bounding box, fetches each listing's page and
calendar, writes the day to the database in one transaction, and runs the
data-quality checks.

## Tables

- `listing_observations`: one row per listing per scrape date, including
  whether its page was read (`page_fetch_ok`)
- `calendar_status`: nightly availability, stored change-only with
  `valid_from`/`valid_to`
- `scrape_runs`: one row per run, with counts and errors
- `listings` *(view)*: one row per listing version, derived from the
  observations. `listings_current` filters to `is_current`. `host_id` is the
  primary host's Airbnb user id (`airbnb.com/users/show/<host_id>`), stable
  for the life of the host account; a change of host opens a new version.
  Co-hosts are not recorded.
- `calendar_current` *(view)*: use this instead of `calendar_status` for
  "how many are operating/booked"; it drops the frozen future nights of
  retired listings

## Known gaps

- **Most listings have no street address.** `location_exact_address` is null
  unless the host published one. Join on `location_lat`/`location_lng`, and
  filter on `location_is_exact` first: about half those coordinates are
  Airbnb's privacy jitter. Resolving the rest is a deferred follow-up; see
  the PRD.

## Repo layout

A pnpm workspace sharing `tsconfig.base.json`:

- `packages/scraper`: the daily pipeline and DuckDB schema. Runtime
  dependencies are `impit` (an HTTP client that impersonates Chrome's TLS
  fingerprint, which Airbnb requires) and `@duckdb/node-api`. The Airbnb
  endpoints are in `packages/scraper/src/airbnb/`.
- `packages/ui`: the browser viewer.

See [CONTRIBUTING.md](./CONTRIBUTING.md) to run or change the pipeline, and
the [PRD](./docs/prd.md) for goals.
