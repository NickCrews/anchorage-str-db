# `@anchorage-str-db/scraper`

Runs the scrapers and writes what they return to the database defined in
`packages/db`.

- `cli.ts`: `daily` and `registry` commands (run from the repo root as
  `pnpm daily` and `pnpm registry`)
- `pipeline.ts`: the daily run over `scraper-airbnb`
- `registry.ts`: the registry run over `scraper-muni-str` and `muni-licenses`
- `store.ts`, `registryStore.ts`: the writes
- `checks.ts`, `registryChecks.ts`: the quality checks each run ends with
- `config.ts`: database path, retirement rule and check thresholds

The provider packages return records in memory; this package decides what
to store and how. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
