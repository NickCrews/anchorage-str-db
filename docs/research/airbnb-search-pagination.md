# Why the search never paginates

Measured 2026-09-09. Explains the design of `searchAnchorage` in
`packages/scraper-airbnb/src/search.ts`. Read it before changing how the search is
partitioned.

**Summary:** Airbnb's paginated search is unreliable in two ways, both caused
by pagination. A query whose results fit on one page has neither problem, so
the search splits by price until every query fits on one page.

## The two defects

### 1. Results stop at 280 items without warning

Airbnb serves at most 280 items per query. The last page reports
`"nextPageCursor": null`, the same as a genuinely finished search.

The limit is on items, not pages: `itemsPerGrid=20` gives 14 pages, 40 gives 7.

One Anchorage-wide query returned 255 distinct listings. The same area split
into four quadrants returned 943, and three of the quadrants hit 280.

### 2. Results are re-ranked between page fetches

Some listings appear on two pages and others on none. The count stays the
same but the set changes. Three identical calls for one bbox and price band:

```
run 1: 170 results, 169 distinct
run 2: 170 results, 161 distinct
run 3: 170 results, 156 distinct
union 170, present in all three 146, churned 24
```

This happens well below the 280 cap.

### Churn grows with page count

Three identical queries at each size:

| pages | listings differing between runs |
|------:|-------------------------------:|
|     1 | **0** |
|     3 | 10–20 |
|     5 | 27–32 |
|     7 | 69 |

A single-page query returns the same set every time.

## Price bands share boundaries without overlap

`price_max=X` and `price_min=X` are complementary: a listing priced exactly X
lands on one side only. Single-page queries against a 26-listing box:

| split at | below | above | duplicates | lost |
|---------:|------:|------:|-----------:|-----:|
|     $100 |    19 |     7 |          0 |    0 |
|     $125 |    24 |     2 |          0 |    0 |
|     $150 |    25 |     1 |          0 |    0 |
|     $200 |    25 |     1 |          0 |    0 |

Test boundaries only on single-page queries. On a multi-page query, churn
looks like listings lost at the boundary.

The densest $1–2 bands (around $150 and $200) return 36 of a possible 40. A $1
band needing two pages would mean more than 40 listings at one price;
`search_single_page` fails the run in that case, and the search would need to
split by geography instead.

## Approaches that don't work

- **A stable sort order.** `rank_mode` accepts `price_low_to_high`,
  `price_high_to_low`, `default`, `relevance`, `top_reviewed`, `distance` and
  `newest` without error, and every value gives the same churn.
- **Larger pages.** `itemsPerGrid` caps at 40; 50, 100 and 200 all return 40.
- **A map-results endpoint.** `includeMapResults: true` adds no separate
  results; there is only `results.searchResults`.
- **Text search.** `query=Anchorage, Alaska` has the same 280 cap, and 26% of
  its results fell outside the municipality (826 in Mat-Su). It also found
  fewer listings inside the municipality than the bbox. A bbox can be tested
  against parcel data, which `test/config.test.ts` does.
- **Zoom.** Zoom 11 through 15 return identical sets for the same box.
- **Unioning two partitions.** Geographic and price splits each found ~2400
  listings, with ~150 differences each way. Their union reached 2560;
  single-page queries reach more with fewer requests.

## Cost comparison

Same city, same day:

| approach | listings | requests | wall time | reproducible |
|---|---:|---:|---:|---|
| one query | 252 | 7 | ~10s | — |
| price bands, one pass each | 2402 | ~190 | 357s | no |
| price bands, repeated until stable | 2616 | ~470 | 652s | approximately |
| **price bands split to one page** | **2625** | **181** | **243s** | **yes** |

Two consecutive runs of the single-page approach differed by 2 of 2625
listings, consistent with real changes over the four minutes between them.

## pyairbnb

pyairbnb's `search_all` walks every page and returns a flat list, so it has
both defects and callers can't detect either. This project never paginates.
`paginationInfo.pageCursors` in the first response gives the page count.
