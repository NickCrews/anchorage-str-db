# `@anchorage-str-db/licenses`

The license scan: records every license the Muni's CityView portal
publishes, by reading license pages by id, and writes them to the database
defined in `packages/db`. An app like `packages/scraper`, over
`muni-licenses`; it never imports `scraper`.

- `cli.ts`: the `scan` command (run from the repo root as `pnpm licenses`)
- `scan.ts`: the scan: newest id, choose ids, read pages, write, check
- `select.ts`: `chooseLicenseIds`, which ids a scan reads
- `store.ts`: the read history, the writes and the run log
- `checks.ts`: the quality checks each scan ends with

```sh
pnpm licenses
node packages/licenses/src/cli.ts --db /tmp/scratch.duckdb --max-reads 60 --verbose scan
```

`--max-reads` caps the scan below `MAX_READS_PER_SCAN` (3000), for a quick
run against a scratch database.

## What a scan reads

`cityviewLicenseId` is one counter across every license type, in creation
order, never reused. Most ids are hidden license ids. The read history in
the database is the scan's only state: `muni_license_page_reads` (visible
pages) and `muni_license_hidden_reads` (hidden ids).

Each scan finds the newest id from the License Locator, then reads up to
3000 ids in this order (`chooseLicenseIds`):

1. ids above the highest id ever read, visible or hidden, up to the newest,
   newest first;
2. ids never read, from the highest id ever read down to 1, newest first;
3. hidden ids among the 500 newest ids, last read 1 day ago or more;
4. Short-Term Rentals licenses last read 7 days ago or more;
5. licenses of other types last read 30 days ago or more;
6. older hidden ids last read 90 days ago or more.

Within 3 to 6 the oldest read goes first. A failed read writes nothing, so
the id keeps its place for the next scan. From an empty database the first
scan reads the newest 3000 ids, which hold every Short-Term Rentals license
(ids from 13607), and the rest of the ~16,500 ids follow over about five
more scans. Once caught up, a scan reads well under 3000 ids: about 400
Short-Term Rentals licenses, the newest hidden ids, and a share of the rest.

## Writes

All reads come first, then one transaction writes them and the
`muni_license_runs` row. A read replaces any read of the same id earlier the
same day, visible or hidden, so re-running a day is safe. A failed scan logs
a `muni_license_runs` row with `error_summary` after the rollback.

`licenses_new` counts visible pages of licenses with no visible read before
the scrape date; `licenses_status_changed` counts those whose page status or
issuance statuses differ from the license's previous visible read.

## Checks

| check | severity | fails when |
| --- | --- | --- |
| `license_run_logged` | error | the scan logged no completed run |
| `license_page_failure_rate` | error | more than 25% of reads failed |
| `license_page_fields_present` | error | fewer than 95% of visible pages read had a status and an issuance |
| `registration_id_format` | warn | an STR Certificate read has a number that is not `STR` + 8 digits |
| `newest_license_read` | warn | the newest id has never been read |

## Tests

`pnpm test` in this package runs offline: `test/select.test.ts` covers the
order above, and `test/scan.test.ts` runs the scan against a real DuckDB
file with injected page reads.
