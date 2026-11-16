# `@anchorage-str-db/licenses-scraper`

The license scrape: records every license the Muni's CityView portal
publishes, by reading license pages by id, and writes them to the database
defined in `packages/db`, then geocodes their addresses. An app like
`packages/airbnb-scraper`, over `licenses-client` and `muni-gis-client`; it never imports
`airbnb-scraper`.

- `scrape.ts`: the scrape: newest id, choose ids, read pages, write, geocode,
  check
- `select.ts`: `chooseLicenseIds`, which ids a scrape reads
- `geocode.ts`: `runGeocodePass`, the geocoding pass
- `store.ts`: the read history, the writes and the run log
- `checks.ts`: the quality checks each scrape ends with

```sh
pnpm scrape licenses
pnpm scrape licenses --db /tmp/scratch.duckdb --budget-seconds 60 --verbose
```

`--budget-seconds` sets the time budget of both passes (page reads, then
geocoding), for a quick run against a scratch database.

## What a scrape reads

`cityviewLicenseId` is one counter across every license type, in creation
order, never reused. Most ids are hidden license ids. The read history in
the database is the scrape's only state: `muni_license_page_reads` (visible
pages) and `muni_license_hidden_reads` (hidden ids).

Each scrape finds the newest id from the License Locator, then reads ids in
this order (`chooseLicenseIds`) until its budget is spent:

1. ids above the highest id ever read, visible or hidden, up to the newest,
   newest first;
2. ids never read, from the highest id ever read down to 1, newest first;
3. hidden ids among the 500 newest ids, last read 1 day ago or more;
4. Short-Term Rentals licenses last read 7 days ago or more;
5. licenses of other types last read 30 days ago or more;
6. older hidden ids last read 90 days ago or more.

Within 3 to 6 the oldest read goes first. A failed read writes nothing, so
the id keeps its place for the next scrape. From an empty database the first
scrape reads the newest ids, which hold every Short-Term Rentals license (ids
from 13607), and later scrapes read the rest of the ~16,500 ids. Once caught
up, a scrape reads about 400 Short-Term Rentals licenses, the newest hidden
ids, and a share of the rest.

## Budget

A scrape starts page reads for 45 minutes (`LICENSE_READ_BUDGET_MS`), then
geocodes for 10 minutes (`GEOCODE_BUDGET_MS`). A pass starts no request once
its budget is spent and writes what it has. An id or address it did not reach
has no row, so it keeps its place for the next scrape. Together the passes take
at most about 55 minutes, inside the workflow's 90-minute timeout.

## Writes

All reads come first, then one transaction writes them and the
`muni_license_scrape_runs` row. A read replaces any read of the same id earlier the
same day, visible or hidden, so re-running a day is safe. A failed scrape logs
a `muni_license_scrape_runs` row with `error_summary` after the rollback.

`licenses_new` counts visible pages of licenses with no visible read before
the scrape date; `licenses_status_changed` counts those whose page status or
issuance statuses differ from the license's previous visible read.

## The geocoding pass

After the page reads are written, `runGeocodePass` fills
`muni_address_geocodes` (see `packages/muni-gis-client` for the services):

1. It takes the `address` of every license in `licenses`, of every type,
   that has no row in `muni_address_geocodes`, then those whose row has no
   match and is 90 days old or more, at most 1000 a scrape, Short-Term Rentals
   licenses first. From an empty database the ~3,000 addresses take three
   scrapes; after that a scrape geocodes the day's new licenses.
2. If there are any, it fetches the community council polygons, geocodes
   each address, and finds the council of each match.
3. One transaction writes the rows; a row replaces the address's earlier
   one.

An address the geocoder answered without a match is stored with NULL
`matched_address`, coordinate and council, and its best candidate's `score`
and `match_type` (`StreetName` when it placed only the street), so it is
not asked about again for 90 days. A match is kept for good: an address
does not move, and its council is the one containing it when it was
geocoded. A failed request writes nothing and is retried next scrape.

The pass runs after the page reads' transaction, so it can read the
addresses those reads hold from `licenses`, and so its failure leaves them
written: the scrape logs the error and the `geocode_failure_rate` check warns.
Its counts are logged, not stored in `muni_license_scrape_runs`; the rows'
`geocoded_date` records which scrape wrote them.

The council is stored on the geocode rather than joined in SQL from stored
polygons, so neither the views nor the browser viewer need DuckDB's spatial
extension, and a council follows the coordinate it was found from.

## Checks

| check | severity | fails when |
| --- | --- | --- |
| `license_run_logged` | error | the scrape logged no completed run |
| `license_page_failure_rate` | error | more than 25% of reads failed |
| `license_page_fields_present` | error | fewer than 95% of visible pages read had a status and an issuance |
| `registration_id_format` | warn | an STR Certificate read has a number that is not `STR` + 8 digits |
| `newest_license_read` | warn | the newest id has never been read |
| `geocode_failure_rate` | warn | the geocoding pass failed, or more than 25% of its geocodes failed |
| `geocode_match_rate` | warn | fewer than 85% of all addresses in `muni_address_geocodes` have a match |

## Tests

`pnpm test` in this package runs offline: `test/select.test.ts` covers the
order above, and `test/scrape.test.ts` runs the scrape, geocoding pass included,
against a real DuckDB file with injected page reads and GIS services.
