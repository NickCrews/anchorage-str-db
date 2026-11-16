# `@anchorage-str-db/airbnb-scraper`

Runs the Airbnb scraper and writes what it returns to the database defined in
`packages/db`.

- `pipeline.ts`: the daily run over `airbnb-client`
- `store.ts`: the writes
- `checks.ts`: the quality checks each run ends with, and the thresholds they
  hold a run to

The Muni's licenses are read by `packages/licenses-scraper`, a separate app writing
the same database.

The client packages return records in memory; this package decides what
to store and how. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
