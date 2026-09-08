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
- An optional browser viewer in `ui/`

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
uv run anchorage-str-db --db data/anchorage_str.duckdb daily
```

That is the whole run, and the only way to invoke it: search the Anchorage
bbox, fetch each listing's own page (for details like whether the map
coordinate is exact or privacy-shifted) and its calendar, then merge the
whole day into the database in one transaction and run the quality gate.

## Plain-Language Table Guide

- `listings`: current and historical listing details
- `listing_observations`: which listings were seen on each scrape date
- `calendar_status`: nightly open/booked-like availability states
- `scrape_runs`: run health, counts, and failures

## Goals and more info

See [](./docs/prd.md)
