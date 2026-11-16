# `@anchorage-str-db/parcels-scraper`

The parcel import: copies the current parcels from
[anchorage-property](https://github.com/NickCrews/anchorage-property)'s
published DuckDB file into `property_parcels`, so `licenses` and
`registrations` can join a license's parcel id to its property type and
living units. An app like `packages/licenses-scraper`, with no client
package: DuckDB attaches the published file and copies its rows directly.
anchorage-property reads the Muni's parcel layer and keeps each parcel's
history, and this repo keeps only the current state.

- `import.ts`: the import: read the source, check it, replace the table
- `store.ts`: reading the source, the write and the run log
- `checks.ts`: the checks the source must pass before the table is replaced

```sh
pnpm scrape parcels
pnpm scrape parcels --db /tmp/scratch.duckdb --verbose
pnpm scrape parcels --db /tmp/scratch.duckdb --source ./anchorage-current.duckdb
```

## The source

`anchorage-current.duckdb`
(`https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb`,
about 36 MB) holds anchorage-property's `parcels_current`, one row per
parcel keyed by `parcel_id`, the Muni's 11-digit Parcel_ID ('07606227000'),
the same id a license page's Property location holds, and `ingest_runs`, its
run log. DuckDB attaches it read-only over HTTPS and range-reads only the
columns the import selects. See anchorage-property's
[DATABASE.md](https://github.com/NickCrews/anchorage-property/blob/main/DATABASE.md).

anchorage-property ingests once a day. Its runs have started between about
14:00 and 23:00 UTC; `property_parcel_imports.source_ingest_run` records
which one each import copied.

## What an import does

1. Attaches the source, copies the columns of `property_parcels` from
   `parcels_current` into a temporary table, reads the newest successful
   run in `ingest_runs`, and detaches.
2. Runs the checks below on the copy.
3. If every error-severity check passed, one transaction deletes every row
   of `property_parcels`, inserts the copy with `imported_date` set to the
   import date, and logs the `property_parcel_imports` row.

A source that fails a check leaves `property_parcels` as it was, and the
import logs a row whose `error_summary` names the failed checks and exits
non-zero. Any other failure (the source cannot be reached, a column will
not cast, the write fails) leaves the table as it was too, and the import
logs its error in `error_summary` after the rollback.

`property_parcels` holds the snapshot and nothing else: a parcel the Muni
retires disappears at the next import. `valid_from` is when
anchorage-property last saw the parcel change; ask it for history.

## Checks

| check | severity | fails when |
| --- | --- | --- |
| `parcel_source_columns` | error | `parcels_current` is missing, or lacks a column `property_parcels` takes |
| `parcel_count` | error | the source has fewer than 90,000 parcels (the Muni has about 98,500) |
| `parcel_id_unique` | error | a `parcel_id` appears twice, or a row has none |
| `parcel_source_fresh` | warn | the source's newest successful ingest run started more than 3 days before the import date, or it records none |

## Tests

`pnpm test` in this package runs offline: `test/import.test.ts` builds a
small DuckDB file shaped like the source and imports from it.
