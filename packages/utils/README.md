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
| `checks` | `CheckResult` and `report`: the data-quality checks a run ends with, logged, and whether any error-severity one failed |
| `concurrency` | `mapWithConcurrency`: one job per item, at most N at a time |
| `pace` | `TokenBucket` and `Pacer`: a request rate per remote service, with the service's failure policy: what counts as a rate limit and a timeout (`classify`), whether a rate limit slows down and waits or pauses every request (`rateLimit`), and whether a lowered rate recovers (`recoverAfter`) |
| `retry` | `withRetries`: the paced attempt loop; each failure goes to the pacer, which applies its policy |
| `http` | `fetchText`: a GET with a timeout that throws `HttpStatusError` (with any `Retry-After`) on a non-2xx response; `fetchCookies`: the cookies a page sets, for a `Cookie` header |
| `muni_geography` | `MUNICIPALITY_BOUNDARY`: the Municipality's boundary as GeoJSON, which `municipality.sql` builds; `MUNICIPALITY_BOUNDING_BOX` is its extent; `inMunicipality` tests a coordinate against it, `inRings` tests one against any rings (the community councils use it), and `boundingBox` finds any collection's extent. A folder, imported as `@anchorage-str-db/utils/muni_geography` |

Import by module path:

```ts
import { addDays } from '@anchorage-str-db/utils/dates';
```

Each service gets its own `Pacer`, made once with that service's limits and
policy; every call to the service passes it to `withRetries`. By default a
429 (`HttpStatusError`) halves the rate and is retried after a wait, honouring
`Retry-After`; the CityView portal, ArcGIS and the geocoder use that.
Airbnb's requests are paced by airbnb-dlp instead.
