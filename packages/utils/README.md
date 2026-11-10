# `@anchorage-str-db/utils`

Helpers shared by the scraper packages.

**This package has no runtime dependencies, and must keep it that way.** It
uses only Node built-ins (`fetch`, `AbortSignal`, `performance`, `fs`), so every
package can depend on it without pulling in anything else. Code that needs a
third-party library belongs in the package that uses it.

| module | what it is |
| --- | --- |
| `dates` | ISO `YYYY-MM-DD` dates, the representation used throughout |
| `log` | leveled logging to stderr; `describeError` and `rootCause` for run logs |
| `concurrency` | `mapWithConcurrency`: one job per item, at most N at a time |
| `pace` | `TokenBucket` and `Pacer`: a request rate per remote service, halved after a streak of timeouts |
| `retry` | `withRetries`: the paced attempt loop, given the service's pacer and what counts as its rate limit |
| `http` | `fetchText`: a GET with a timeout that throws on a non-2xx response; `fetchCookies`: the cookies a page sets, for a `Cookie` header |
| `muni_geography` | `MUNICIPALITY_BOUNDARY`: the Municipality's boundary as GeoJSON, which `municipality.sql` builds; `MUNICIPALITY_BOUNDING_BOX` is its extent; `inMunicipality` tests a coordinate against it and `boundingBox` finds any collection's extent. A folder, imported as `@anchorage-str-db/utils/muni_geography` |

Import by module path:

```ts
import { addDays } from '@anchorage-str-db/utils/dates';
```

Each caller creates its own `Pacer`, since each service has its own limits.
`scraper-airbnb/src/pace.ts` is an example: one process-wide pacer at
Airbnb's rate, whose 429 aborts the run.
