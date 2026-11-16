# `@anchorage-str-db/cli`

The one command line for every scraper. It parses the options and calls a
`*-scraper` package's run; it holds no logic of its own.

```sh
pnpm scrape airbnb      # runDaily, packages/airbnb-scraper
pnpm scrape licenses    # runScan, packages/licenses-scraper
pnpm scrape parcels     # runImport, packages/parcels-scraper
pnpm scrape --help
```

`--db`, `--date` and `--verbose` apply to every source. `--max-reads` applies
only to `licenses` and `--source` only to `parcels`; either with another
source is a usage error. A usage error exits 2, a run that fails an
error-severity check exits 1.
