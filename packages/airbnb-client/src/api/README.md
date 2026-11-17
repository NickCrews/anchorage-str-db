# `src/api`: Airbnb's unofficial API

These files call the internal GraphQL endpoints Airbnb's website uses. They
are undocumented and change without notice, so this directory holds only one
file per endpoint plus the shared HTTP client.

| file | endpoint | what it is |
| --- | --- | --- |
| `apiKey.ts` | `www.airbnb.com/` | the public web API key, read from the homepage HTML |
| `search.ts` | `POST /api/v3/StaysSearch/<hash>` | map search, and the standardizer for its response |
| `calendar.ts` | `GET /api/v3/PdpAvailabilityCalendarV2Query/<hash>` | twelve months of nightly availability |
| `priceQuote.ts` | `GET /api/v3/StaysPdpBookItQuery/<hash>` | the booking sidebar's price for one stay, given check-in and check-out |
| `reviews.ts` | `GET /api/v3/StaysPdpReviewsQuery/<hash>` | a page of reviews, newest first, and the total count; only review dates are read |

Each endpoint is pinned to a persisted-query hash (`OPERATION_ID`), which
Airbnb rotates. If an endpoint starts returning 400, check its hash first.
Airbnb sometimes renames an operation or changes its variables at the same
time. `pnpm airbnb:check` says which endpoint broke and how, and `pnpm
airbnb:capture` reads the current hashes from a real browser; see "Airbnb API
changes" in `CONTRIBUTING.md`.

`http.ts` is the shared `impit` client impersonating Chrome 124. Airbnb sits
behind Akamai, which fingerprints the TLS ClientHello and refuses Node's own
`fetch`.

In the `search.ts` standardizer:

- **`listingId` is a `bigint`.** Newer listing ids are 19 digits, beyond what a
  JS number holds exactly.
- **A missing coordinate is `null`, not `0`.** A `0` default would place the
  listing at (0, 0) and look like a real position downstream.

## Hash source

The endpoint shapes and request parameters started from
[pyairbnb](https://github.com/johnbalvin/pyairbnb) (MIT, © 2024 John Balvin).
To find a current hash and variables, open a listing (or a search) on
airbnb.com with the browser's network tab open, and copy the
`/api/v3/<operation>/<hash>` request: its URL path holds the hash and its
`variables` parameter (or POST body) the variables. The search hash also
appears in the page's JS bundles as `name:'StaysSearch',type:'query',operationId:'…'`.
