# Why the search never paginates

Measurement date: 2026-09-09. Reference notes behind the shape of
`airbnb_client.search_anchorage()`. You need this only if you are changing
how the search is partitioned, or if Airbnb's behaviour appears to have
changed under it. Nothing here affects how the stored data is interpreted.

Bottom line up front: **Airbnb's paginated search is unreliable in two
separate ways, and both live in pagination.** A query whose whole result set
fits on one page has neither problem, so the search splits by price until
every query is answerable in a single request. The alternatives below were
measured and rejected; they are recorded so nobody re-runs the experiments.

## The two defects

### 1. It truncates at 280 items and does not say so

Airbnb serves at most 280 items per query, however many match. The last page
it will serve reports `"nextPageCursor": null` — identical to a genuinely
exhausted search. There is no error, no flag, and nothing in the response
that distinguishes "this is all of them" from "this is the first 280".

The limit is on **items, not pages**: `itemsPerGrid=20` yields 14 pages,
`itemsPerGrid=40` yields 7.

One Anchorage-wide query returned 255 distinct listings and looked complete.
The same rectangle asked as four quadrants returned 943, and three of those
four were themselves pinned at 280.

### 2. It re-ranks between page fetches

The same listing is returned on two pages while another is skipped entirely.
The result *count* is stable; the set is not. Three identical calls for the
same bbox and price band:

```
run 1: 170 results, 169 distinct
run 2: 170 results, 161 distinct
run 3: 170 results, 156 distinct
union 170, present in all three 146, churned 24
```

This bites well below the 280 cap, which is what makes it easy to miss.

### Churn is purely a function of page count

Three identical queries at each size:

| pages | listings differing between runs |
|------:|-------------------------------:|
|     1 | **0** |
|     3 | 10–20 |
|     5 | 27–32 |
|     7 | 69 |

A single-page query returns an identical set on every repeat. That is the
whole basis for the current design.

## Price bands abut; they do not overlap

`price_max=X` and `price_min=X` are complementary — a listing priced exactly
X lands in one side and only one. Measured on single-page (therefore stable)
queries against a 26-listing box:

| split at | below | above | duplicates | lost |
|---------:|------:|------:|-----------:|-----:|
|     $100 |    19 |     7 |          0 |    0 |
|     $125 |    24 |     2 |          0 |    0 |
|     $150 |    25 |     1 |          0 |    0 |
|     $200 |    25 |     1 |          0 |    0 |

An earlier version of this project overlapped the bands, on a measurement
showing two listings lost at a $150 split. That measurement was taken on a
three-page query: it was pagination churn, not a boundary gap. Overlap is
unnecessary, and removing it is what makes $1-wide bands possible.

Headroom: the densest $1–2 bands in Anchorage sit around the round numbers
($150, $200) and return 36 of a possible 40. If a $1 band ever needs two
pages there are more than 40 listings at a single price, which price cannot
separate — `checks.search_single_page` fails the run, and geography would
have to take over as the splitting axis.

## Things that do not work

Measured and rejected. Re-testing these is unlikely to be a good use of time
unless Airbnb has changed.

- **A stable sort to page against.** `rank_mode` is a real filter key — it
  appears in `resetKeys` and in the response's `ExploreFilterState`. Airbnb
  accepts `price_low_to_high`, `price_high_to_low`, `default`, `relevance`,
  `top_reviewed`, `distance` and `newest` without error and **ignores all of
  them**: identical slot counts and identical churn for every value.
- **Larger pages.** `itemsPerGrid` works downward (20 gives 20 per page) but
  clamps at 40; 50, 100 and 200 all return 40.
- **An unpaginated map endpoint.** `includeMapResults: true` is already sent.
  The response carries no separate map section, only `results.searchResults`.
- **Text/place search instead of a bbox.** `query=Anchorage, Alaska` resolves
  correctly (279/280 results inside the bbox) but hits the same 280 cap, and
  Airbnb's idea of "Anchorage" is not the Municipality: 26% of its results
  were outside the municipal parcel extents, 826 of them north in Mat-Su
  (Wasilla, Palmer, Big Lake). It also finds fewer listings inside the
  municipality than the bbox does. The bbox is kept because it is an explicit
  scope we can check against parcel data, which
  `tests/test_config.py` does.
- **Zoom.** `zoomLevel` does not change what a box returns; zoom 11 through 15
  give identical result sets. The bbox alone selects the listings.
- **Unioning two partitions.** Splitting geographically and splitting by price
  each found ~2400 listings and disagreed by ~150 in both directions, because
  each lost a different random ~12% to churn. Unioning them reached 2560 — but
  that was compensating for a lossy sampler by sampling twice. Fixing the
  sampling reaches more, faster.

## What the approaches actually cost

Same city, same day:

| approach | listings | requests | wall time | reproducible |
|---|---:|---:|---:|---|
| one query (the original bug) | 252 | 7 | ~10s | — |
| price bands, one pass each | 2402 | ~190 | 357s | no |
| price bands, repeated until stable | 2616 | ~470 | 652s | approximately |
| **price bands split to one page** | **2625** | **181** | **243s** | **yes** |

Two consecutive full runs of the current approach differed by 2 listings out
of 2625, which is consistent with real market movement over the four minutes
between them.

## Upstream

Both defects are pyairbnb's `search_all` as much as Airbnb's: it walks every
page and returns a flat list, so it inherits the truncation and the churn
with no way for a caller to detect either. This project therefore drives
pagination itself and never calls `search_all`. `paginationInfo.pageCursors`
carries the page count in the *first* response, before any pagination, which
is what makes "did this query tell me the truth?" something the run reads
rather than infers.
