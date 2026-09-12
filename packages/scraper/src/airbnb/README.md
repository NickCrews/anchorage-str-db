# `src/airbnb` — Airbnb's unofficial API

These call Airbnb's internal `StaysSearch` / `PdpAvailabilityCalendar`
GraphQL endpoints — the same ones the website's map search and listing pages
use — rather than scraping rendered HTML. That is resilient to markup
changes, but it rides on an *unofficial* API surface that can change without
notice, so the surface is kept narrow: three files, one endpoint each, and
nothing else.

| file | endpoint | what it is |
| --- | --- | --- |
| `apiKey.ts` | `www.airbnb.com/` | the public web API key, regexed out of the homepage |
| `search.ts` | `POST /api/v3/StaysSearch/<hash>` | the map search, plus the standardizer for its response |
| `calendar.ts` | `GET /api/v3/PdpAvailabilityCalendar/<hash>` | twelve months of nightly availability |

Each endpoint is pinned to a persisted-query hash. When one starts returning
400s, that hash is the first thing to check — Airbnb rotates them.

`http.ts` is the shared client: one `impit` instance impersonating Chrome
124. That is not a detail to drop. Airbnb sits behind Akamai, which
fingerprints the TLS ClientHello; Node's own `fetch` announces itself as Node
and is refused.

Two things worth knowing about the standardizer in `search.ts`:

- **`roomId` is a `bigint`.** Airbnb's newer listing ids are 19 digits, past
  what a JS number holds exactly, and rounding one renames the listing to a
  neighbour that may well exist.
- **A missing coordinate is `null`, not `0`.** Defaulting it puts an unplaced
  listing in the Gulf of Guinea, where it reads as a real position to
  everything downstream.

## Where the hashes come from

The endpoint shapes, request parameters and persisted-query hashes follow
[pyairbnb](https://github.com/johnbalvin/pyairbnb) (MIT, © 2024 John Balvin),
which tracks Airbnb's rotations — check it first when a hash stops working.
