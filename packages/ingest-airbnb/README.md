# `@anchorage-str-db/ingest-airbnb`

Runs the Airbnb scraper and writes what it returns to the database defined in
`packages/db`.

- `cli.ts`: the `daily` command (run from the repo root as `pnpm daily`)
- `pipeline.ts`: the daily run over `scraper-airbnb`
- `store.ts`: the writes
- `checks.ts`: the quality checks each run ends with, and the thresholds they
  hold a run to

The Muni's licenses are read by `packages/ingest-muni-licenses`, a separate app writing
the same database.

The provider packages return records in memory; this package decides what
to store and how. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
