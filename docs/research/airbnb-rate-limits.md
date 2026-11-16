# Airbnb's rate limit

Measured 2026-09-09/10 from one residential IP against live Airbnb, cycling
through 79 room ids from two Anchorage price-band queries. Explains
`packages/airbnb-client/src/pace.ts` and its `REQUESTS_PER_SECOND`.

**Summary:** Airbnb allows about 130 requests per IP in a rolling window of
roughly a minute, regardless of burst rate, so the sustainable rate is about
2.2/s. Slightly exceeding it stalls connections; greatly exceeding it bans the
IP for an hour or more. The run is paced by one shared rate below that limit.

## Latency is server-side

Sequential, 12 listing pages, no pacing:

| | p50 |
|---|---|
| HTTP | 0.943 s |
| parse | 0.037 s |
| page size | 487 KB |

Parsing is 4% of a listing's time. Reusing a keep-alive connection cut p50 by
~7%. Most of the time is Airbnb's response latency, so only concurrent
requests reduce total time.

## Short bursts don't reveal the limit

24 listings per level, no pacing:

| concurrency | listings/s | errors |
|---|---|---|
| 4 | 2.81 | none |
| 8 | 6.79 | none |
| 16 | 10.79 | none |
| 32 | 16.05 | none |

Latency stayed flat (p50 ~1.0s).

## Sustained load hits the limit

600 page requests at concurrency 16, per 100 requests:

| requests | lat p50 | errors |
|---|---|---|
| 100 | 0.93s | none |
| 200 | 0.75s | **67 x HTTP 429** |
| 300 | 0.42s | **100 x HTTP 429** |
| 400-600 | ~0.38s | 100 x HTTP 429 each |

467 of 600 were refused. Latency fell because 429s are served quickly, so
throughput metrics must account for status codes.

## The limit is a request count

Three trips against `www.airbnb.com/rooms/`:

| rate | requests before trip | elapsed |
|---|---|---|
| ~17/s | ~133 | ~8s |
| ~17/s | ~130 | ~8s |
| 4/s | ~129 | ~32.5s |

The count stayed at ~130 across a 4x range in elapsed time. The window is
longer than 32.5s (from the 4/s trip) and shorter than ~104s (runs at 1.25/s
never tripped), so ~60s fits, giving ~2.2/s.

1400 requests at 2.0/s ran 11.7 minutes with no 429s and 10 timeouts. p50
latency rose from 0.8s to 3.1s between t=240s and t=450s, then recovered, so
`REQUESTS_PER_SECOND` is set below 2.0.

## Two kinds of overage

**Mild (4/s):** no 429s. Connections stopped responding, every worker waited
on a timeout, and throughput fell to ~1.8/s. This shows only as rising latency
and timeouts, which `Pacer.noteTimeout` responds to.

**Severe (17/s):** the IP was still blocked 32.6 minutes later and cleared
about 70 minutes after that, so roughly 1–2 hours.

The ban covers the whole domain. Probed while blocked:

```
homepage=429   pdp=429   calendar=429
```

The API key is read from the homepage, so a blocked IP can't start a run. All
passes share one budget, so running them concurrently doesn't help.

## The 429 response

There is no `Retry-After`, `RateLimit-*` or `X-RateLimit-*` header, so the
block length can't be read from the response.

The refusal comes from Akamai, not Airbnb's application:

```
server: nginx
akamai-request-bc: [a=23.46.208.137,...]
set-cookie: ak_bmsc=...                  <- Akamai Bot Manager
x-airbnb-fluffy: {"decision":"NONE","crawler":"none","ip_whitelisted":false}
```

`fluffy`, Airbnb's own bot detector, reports `decision: NONE`.

The status is 429 but the body is Airbnb's generic "503 Service Unavailable"
page (`etag: "6aa1ab12-6df"`, 1759 bytes). Classifying failures by body text
would treat a rate limit as an outage, so the code checks the status code.

## Not factors

**Cookies.** Requests without a cookie jar get a new device id (`bev`) each
time. The ban still hit three endpoints at once across requests with
different `bev` values, which indicates an IP-keyed limit.

**TLS fingerprint vs. User-Agent mismatch.** A Chrome 146 TLS fingerprint with
a Chrome 120 User-Agent still tripped at a stable ~130 requests.

## Reducing requests

The page pass is 2600 of a run's ~5400 requests and mostly re-reads two
fields that rarely change (`location_is_exact`, `registration_id`).
Fetching pages only for new listings plus a rotating 1/7 of the rest would cut
that pass to ~400 requests.

The views already support this: `listing_versions` carries page fields forward
across days where `page_fetch_ok` is false, and `listing_activity` exposes
`page_seen_date`. It would need a third page state, **skipped**, separate from
**failed**, so that `listing_page_failure_rate` keeps measuring real failures.
This is not implemented.
