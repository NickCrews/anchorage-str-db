# anchorage-str-db

Work in progress, not working yet.

This project keeps a daily record of short-term rentals (STRs) in Anchorage,
Alaska from Airbnb. It is built to answer straightforward public-interest
questions like:

- How many listings are active right now?
- How has that changed over time?
- How many nights look booked vs. open?

The goal is to replace guesses with a consistent, date-stamped database.

## What You Get

- One local DuckDB file: `anchorage_str.duckdb`
- A daily snapshot history of listings and calendar availability
- Ready-to-run policy-oriented queries in `queries/policy_questions.sql`
- An optional browser viewer in `packages/ui/`

## Quick Start

```sh
gh release download latest-data --repo <owner>/anchorage-str-db -O anchorage_str.duckdb
duckdb anchorage_str.duckdb
```

Then run a quick check:

```sql
SELECT count(*) FROM listings WHERE is_current;
```

## Daily Run

From the repo root:

```sh
pnpm install
pnpm daily
```

That is the whole run, and the only way to invoke it: search the Anchorage
bbox, fetch each listing's own page (for details like whether the map
coordinate is exact or privacy-shifted) and its calendar, then merge the
whole day into the database in one transaction and run the quality gate.

## Plain-Language Table Guide

Two tables hold everything; the rest are views over them.

- `listing_observations`: one row per listing per scrape date — everything
  we saw about it that day, including whether we managed to read its own
  page (`page_fetch_ok`)
- `calendar_status`: nightly open/booked-like availability states, stored
  change-only with `valid_from`/`valid_to`
- `scrape_runs`: run health, counts, and failures
- `listings` *(view)*: current and historical listing details, one row per
  version, rebuilt from the observations. `listings_current` is the same
  thing filtered to `is_current`.
- `calendar_current` *(view)*: the calendar rows worth believing — use this
  rather than `calendar_status` for "how many are operating/booked",
  otherwise retired listings keep reporting frozen future nights

## Known Gaps

- **There is no street address for most listings.** `location_exact_address`
  is nullable and null unless the host chose to publish one on Airbnb. Join
  on `location_lat`/`location_lng` instead — and read
  `location_is_exact` first, because roughly half those coordinates are
  Airbnb's privacy jitter rather than the real spot. Resolving addresses for
  the rest is a deliberate follow-up, not a thing we're quietly working on;
  see the PRD.

## Repo Layout

A pnpm workspace with two packages, sharing `tsconfig.base.json`:

- `packages/scraper` — the daily pipeline and the DuckDB schema. Depends on
  exactly two runtime packages: `impit` (an HTTP client that impersonates
  Chrome's TLS fingerprint, without which Airbnb refuses us) and
  `@duckdb/node-api`. The Airbnb endpoints it calls live in
  `packages/scraper/src/airbnb/`, which has its own README.
- `packages/ui` — the browser viewer.

## Goals and more info

See [](./docs/prd.md)
