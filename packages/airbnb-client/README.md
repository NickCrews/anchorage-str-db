# `@anchorage-str-db/airbnb-client`

Searches Airbnb for listings in the Municipality of Anchorage and fetches
each listing's page, calendar, price quote and earliest review, in memory.
`packages/airbnb-scraper` runs the passes and stores the results.

| module | what it does |
| --- | --- |
| `search` | `searchAnchorage`: every listing in the bounding box, split by price band so no query paginates; `auditCoverage` checks the bands miss nothing |
| `parse` | `parseListing`: a search result as a `ParsedListing` |
| `listingPage` | `fetchListingPages`: exact-location flag, registration id, host, listing type and counts, photos; `collectHostCards` |
| `calendars` | `fetchCalendars`: twelve months of nightly availability |
| `priceQuotes` | `fetchPriceQuotes`: the price of each listing's earliest bookable stay |
| `firstReviews` | `fetchFirstReviews`: each listing's oldest review date |
| `api/` | one file per Airbnb endpoint; see its README |
| `pace`, `retry` | the process-wide Airbnb request rate, and the attempt loop that pauses on a 429 |

Each pass takes its fetcher as an argument (`fetchPage`, `fetchOne`), so
tests run without the network; the `live*Fetcher` functions make the real
requests. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for how the passes fit
together and the request budget.
