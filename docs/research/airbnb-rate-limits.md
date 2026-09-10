# What Airbnb's rate limit actually is, and what it costs to cross it

Measurement date: 2026-09-09/10, from one residential IP, against live
Airbnb. Sample: the 79 room ids returned by two Anchorage price-band
queries, cycled.

Bottom line up front: **Airbnb counts requests per IP over a rolling window
of roughly a minute, with a threshold near 130, and does not care how fast
you got there.** That puts the sustainable rate around 2.2/s. Crossing it
mildly stalls the run; crossing it grossly bans the IP for an hour or more.
The run is now paced by one global budget at `config.REQUESTS_PER_SECOND`.

## The old pacing made the concurrency knobs inert

Each pass paced itself by sleeping in its own submit loop:

```python
for room_id in room_ids:
    time.sleep(random.uniform(MIN_DELAY_S, MAX_DELAY_S))   # serial
    futures[pool.submit(fetch_one, room_id)] = room_id
```

That sleep ran on one thread, serially, *between submissions*. So the pass
rate was `1/mean(delay)` = **1.25/s** regardless of `*_CONCURRENCY`, and at
0.8s spacing against ~0.94s requests, about 1.2 of the 4 workers were ever
busy. Raising the worker count changed nothing at all; the only live knob
was the delay, and shortening it removed pacing rather than raising it.

Pass duration was simply `N x mean(delay)`: 2600 x 0.8s = ~35 min per pass,
~80 min for a run.

## It was never parse cost or connection setup

Sequential, 12 listings, pacing removed:

| | p50 |
|---|---|
| HTTP | 0.943 s |
| `parse_listing_page` | 0.037 s |
| page size | 487 KB |

Parse is **4%** of a listing's time — swapping `html.parser` for `lxml`, or
dropping BeautifulSoup for a regex, optimises the wrong 4%. Reusing one
`curl_cffi.Session` (keep-alive) moved p50 0.943s -> 0.878s, ~7%: real, not
the story. The time is server-side latency on a 487 KB page, and only
overlapping requests touches it.

## Short bursts scale beautifully and prove nothing

24 listings per level, pacing removed:

| concurrency | listings/s | errors |
|---|---|---|
| 4 | 2.81 | none |
| 8 | 6.79 | none |
| 16 | 10.79 | none |
| 32 | 16.05 | none |

Flat latency (p50 ~1.0s) throughout. Read alone this says "go 13x faster".

## Sustained load finds the wall

600 page requests at concurrency 16, bucketed per 100:

| requests | lat p50 | errors |
|---|---|---|
| 100 | 0.93s | none |
| 200 | 0.75s | **67 x HTTP 429** |
| 300 | 0.42s | **100 x HTTP 429** |
| 400-600 | ~0.38s | 100 x HTTP 429 each |

467 of 600 refused. Note the *falling* latency: a 429 is served fast, so
throughput rises as the scrape stops working. **Any speed metric that
ignores status codes scores this failure as a win.**

## It counts requests, not rate

Three trips, all on `www.airbnb.com/rooms/`:

| rate | requests before trip | elapsed |
|---|---|---|
| ~17/s | ~133 | ~8s |
| ~17/s | ~130 | ~8s |
| 4/s | ~129 | ~32.5s |

A stable count across a 4x spread in elapsed time is a request counter, not
a rate limiter. The window is longer than 32.5s (the 4/s trip proves it)
and shorter than ~104s (or the old 1.25/s pacing would have been tripping
all along), so ~60s fits everything and gives ~2.2/s.

**Confirmed directly:** 1400 requests held at 2.0/s ran 11.7 minutes with
zero 429s and 10 timeouts. There was a visible pressure episode in the
middle — p50 latency rose 0.8s -> 3.1s between t=240s and t=450s, then
recovered — which is why `REQUESTS_PER_SECOND` is set below 2.0 rather than
at it.

## Two different punishments

**Mild overage stalls you.** At 4/s no 429 ever arrived. Connections simply
stopped answering: every worker parked in a timeout and throughput sagged to
~1.8/s. Nothing in a success/failure count can see this — it looks like
Airbnb got slow. It is visible only as rising latency, which is what
`pace.Pacer.note_timeout` watches for.

**Gross overage bans you for hours.** The 17/s burst earned a block still
refusing 32.6 minutes later; a quieter follow-up probe (one request per 5
minutes) saw it clear about 70 minutes after that. Call it 1-2 hours.

The ban is **IP-wide, not per-endpoint**. Probed together while blocked:

```
homepage=429   pdp=429   calendar=429
```

The homepage one is the sharp edge: `get_api_key()` scrapes the homepage, so
a blocked run cannot even *start* a pass. And because the calendar endpoint
shares the budget, interleaving the page and calendar passes to overlap them
buys nothing.

## What the 429 response says

No `Retry-After`, no `RateLimit-*`, no `X-RateLimit-*`. **The block length
cannot be read off the response** — hence a conservative fixed rate rather
than a negotiated one.

The refusal comes from the Akamai edge, not Airbnb's application:

```
server: nginx
akamai-request-bc: [a=23.46.208.137,...]
set-cookie: ak_bmsc=...                  <- Akamai Bot Manager
x-airbnb-fluffy: {"decision":"NONE","crawler":"none","ip_whitelisted":false}
```

`fluffy` is Airbnb's own bot detector and reports `decision: NONE` — it
never made a block call.

**The body contradicts the status line.** Status is 429; the body is
Airbnb's generic *"503 Service Unavailable — Stay tuned"* page, identical
across URLs (`etag: "6aa1ab12-6df"`, 1759 bytes). Code that classifies
failures by body text would read a rate limit as an Airbnb outage. Ours keys
off status. Keep it that way.

## Two things ruled out as levers

Both looked promising and neither is the mechanism. Recorded so they are not
re-investigated.

**Session cookies.** Every request used a bare `requests.get`, so the cookie
jar was discarded and Airbnb minted a new device id each time
(`x-erf-bev-bev-is-generated: 1`, a different `bev` per request); a `Session`
holds `everest_cookie`/`bev`/`ak_bmsc` and stops that. But the ban hit three
endpoints simultaneously across calls that each carried a *different* `bev`,
which is what an IP-keyed limit looks like and not what a device-keyed one
looks like. Worth fixing as hygiene; not a rate lever.

**Fingerprint mismatch.** `impersonate="chrome"` resolves to chrome146 in
curl_cffi 0.16.0 while `_HEADERS` hardcodes `Chrome/120.0.0.0` — TLS/JA3 26
versions from the User-Agent it claims, which is exactly the pair Akamai
cross-checks. pyairbnb has the same mismatch. Also hygiene; the limit was
reproducible at a stable ~130 requests regardless.

## The lever this does not pull

Pacing gets the run from ~80 min to ~50. The larger factor is that the page
pass spends 2600 of the run's ~5,400 requests refreshing two nearly-static
fields (`location_is_exact`, `str_registration_id`).

The store already has the machinery for a tiered refresh:

- `listing_versions` carries `page_attrs` forward across days where
  `page_fetch_ok` is false;
- `listing_activity` exposes
  `max(scrape_date) FILTER (WHERE page_fetch_ok) AS page_seen_date`.

Refreshing new listings plus a rotating 1/7 slice would cut that pass from
2600 requests to ~400 — a bigger win than any rate increase, and it
*reduces* exposure to the limit instead of spending it.

`pipeline.run_daily`'s docstring argues against skipping the pass: it would
write "carried-forward stale values rather than today's — a second, quieter
kind of daily record that nothing downstream can distinguish from the real
one." That objection is about *indistinguishability*, and `page_seen_date`
already answers it. What the change genuinely needs is a third state —
**skipped**, distinct from **failed** — because folding "we chose not to
look" into `page_fetch_ok = false` would corrupt
`checks.listing_page_failure_rate`, whose whole job is noticing that Airbnb
stopped answering.

That is a design decision rather than a tuning change, which is why it is
written up here and not implemented.
