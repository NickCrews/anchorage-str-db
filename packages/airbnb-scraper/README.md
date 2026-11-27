# `@anchorage-str-db/airbnb-scraper`

Runs the Airbnb scraper and writes what it returns to the database defined in
`packages/db`.

- `scrape.ts`: the Airbnb scrape
- `airbnb.ts`: its requests, over [airbnb-dlp](https://github.com/NickCrews/airbnb-dlp):
  the search area, which stay to price, which listings' reviews to read, and
  the Anchorage registration id
- `store.ts`: the writes
- `checks.ts`: the quality checks each run ends with, and the thresholds they
  hold a run to

The Muni's licenses are read by `packages/licenses-scraper`, a separate app writing
the same database.

airbnb-dlp returns records in memory; this package decides what to store and
how. `test/e2e` replays a recorded live scrape of a few blocks through the
whole run. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
