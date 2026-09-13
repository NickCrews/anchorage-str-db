# `src/airbnb`: Airbnb's unofficial API

These files call the internal GraphQL endpoints Airbnb's website uses. They
are undocumented and change without notice, so this directory holds only one
file per endpoint plus the shared HTTP client.

| file | endpoint | what it is |
| --- | --- | --- |
| `apiKey.ts` | `www.airbnb.com/` | the public web API key, read from the homepage HTML |
| `search.ts` | `POST /api/v3/StaysSearch/<hash>` | map search, and the standardizer for its response |
| `calendar.ts` | `GET /api/v3/PdpAvailabilityCalendar/<hash>` | twelve months of nightly availability |
| `priceQuote.ts` | `GET /api/v3/StaysPdpSections/<hash>` | the booking sidebar's price for one stay, given check-in and check-out |
| `reviews.ts` | `GET /api/v3/StaysPdpReviewsQuery/<hash>` | a page of reviews, newest first, and the total count; only review dates are read |

Each endpoint is pinned to a persisted-query hash, which Airbnb rotates. If an
endpoint starts returning 400, check its hash first.

`http.ts` is the shared `impit` client impersonating Chrome 124. Airbnb sits
behind Akamai, which fingerprints the TLS ClientHello and refuses Node's own
`fetch`.

In the `search.ts` standardizer:

- **`roomId` is a `bigint`.** Newer listing ids are 19 digits, beyond what a
  JS number holds exactly.
- **A missing coordinate is `null`, not `0`.** A `0` default would place the
  listing at (0, 0) and look like a real position downstream.

## Hash source

The endpoint shapes, request parameters and hashes follow
[pyairbnb](https://github.com/johnbalvin/pyairbnb) (MIT, © 2024 John Balvin),
which tracks Airbnb's rotations.
