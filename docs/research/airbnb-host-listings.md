# A host's listings, from their profile

Measured 2026-09-26: first against 52 hosts from the 2026-09-25 run, then
against all 1210 of them. Explains
`packages/scraper-airbnb/src/api/hostListings.ts` and `hostListings.ts`,
`airbnb_host_profile_listings`, and `host_listing_portfolios.listings`.

**Summary:** `UserProfileBeehiveListingQuery`, the endpoint behind the
listings grid on `airbnb.com/users/show/<host id>` (and behind pyairbnb's
`get_listings_from_user`), returns every listing the host currently has
listed, wherever it is. It has no total count and paginates by offset, and
honours a page size of 1000, so one request covers every host here but one
(a hotel chain with 1990). It is the host listing portfolio that search
cannot give us: counting it, 479 of the 1210 hosts hold 2 or more listings,
against 345 counting only their listings in the Municipality.

## The request

A persisted GraphQL query, taken from pyairbnb 2.2.2 (`pyairbnb/host.py`):

```
GET https://www.airbnb.com/api/v3/UserProfileBeehiveListingQuery/529ca816b8be0619618d48b31bf46c379543e297fd68c0a953922927e5497b43
    ?operationName=UserProfileBeehiveListingQuery
    &locale=en&currency=USD
    &variables={"userId":"121679638","limit":1000,"offset":0}
    &extensions={"persistedQuery":{"version":1,"sha256Hash":"529ca8…7b43"}}
X-Airbnb-Api-Key: <the public web key, as for every other endpoint>
```

`userId` is sent as a string. pyairbnb sends an integer, which a 19-digit id
(e.g. `1673497466101215704`) would overflow in JavaScript. The string form
returned 38 listings for that host.

## The response

```json
{
  "data": {
    "beehive": {
      "__typename": "BeehiveQuery",
      "getListOfListings": {
        "__typename": "BeehiveGetListOfListingsResponse",
        "listings": [
          {
            "__typename": "BeehiveListing",
            "id": "48397619",
            "isNewListing": false,
            "isSuperhost": false,
            "nameOrPlaceholderName": "Snowbird Chalet #5 | Walk to Lift | Fireplace",
            "pictureUrl": "https://a0.muscache.com/im/pictures/prohost-api/Hosting-48397619/original/….jpeg?aki_policy=large",
            "propertyTypeName": "Chalet",
            "ratingAverage": 4.55,
            "reviewCount": "165",
            "roomTypeCategory": "entire_home",
            "localizedRoomType": "Entire home/apt"
          }
        ]
      }
    }
  },
  "extensions": { "traceId": "…" }
}
```

`getListOfListings` carries nothing but the list: no total, no cursor, no
`hasNextPage`. The entries have no coordinate, city or market, so the
endpoint can say how many listings a host holds and which, but not where.
Every one of the 5110 entries in the full run had exactly the eleven fields
above, with the types above; nulls aside, nothing else appeared.

## Pagination

- **Offset and limit are both honoured.** Casago's 65 listings came back as
  12+12+12+12+12+5 at `limit` 12, and as 65 at `limit` 100 or 1000. Evolve's
  207 came back as 100 at `limit` 100 and all 207 at `limit` 1000.
- **No cap below 1000.** LaQuinta By Wyndham (699580001, 6 listings here)
  returned a full page of 1000, then 990, then nothing: 1990 listings. A
  server-side cap would show up as full pages shorter than the limit asked
  for, so a page of 1000 at `limit` 1000 means the limit is honoured, and a
  page shorter than it is the end of the list. My Place Hotels (657455752)
  returned 627 in one page, and a request past it returned nothing.
  `readHostListings` gives up after 50 pages in case the offset is ever
  ignored.
- **Stable order.** The same ids came back in the same order at `limit` 12,
  50 and 100, so paging does not skip or repeat listings when nothing
  changes mid-way. A listing added between two requests would shift later
  pages by one, so ids are de-duplicated.
- **The end is a short page.** Offset 63 of Casago's 65 returned 2, and a
  request past the end returned an empty list for every host sampled. With
  `limit` 1000, a host with under 1000 listings costs exactly one request.

## What is on the profile

Compared against the Anchorage listings the 2026-09-25 run saw under the
same hosts:

- **Every listing search sees is on the profile.** 365 of 365 listings seen
  that day under 48 sampled hosts were on their host's profile. This is what
  the `host_listings_cover_search` check tests.
- **Only listed listings.** Of 11 listings seen on 2026-09-24 but missing
  from search on 2026-09-25, 8 were still on their host's profile: search
  had dropped them for a day, which is why `RETIREMENT_GRACE_DAYS` exists.
  Two were gone from the profile, and their listing pages returned HTTP 410,
  so a deactivated listing leaves the profile. The last one had changed
  hands: its page named a new host (319033542, not 469671681), and it was on
  the new host's profile and gone from the old one's.
- **So inactive, unlisted or deactivated listings are not counted.** The
  count is what the host has listed today, not everything the account has
  ever held. It moves with delistings the same day, while `listings_in_muni`
  waits out the grace period.
- **Listings everywhere.** 21 of 48 hosts listed more than search saw under
  them on 2026-09-25. For 6 of those, search saw none of their listings that
  day (it had dropped them); the other 15 hold more than search saw, mostly
  outside the Municipality. 15 hosts had exactly one listing in each. Some of
  the larger ones, against their listings active in the Municipality on
  2026-09-25:

  | host | active in the Muni | on profile |
  | --- | --- | --- |
  | LaQuinta By Wyndham (699580001) | 6 | 1990 |
  | My Place Hotels By RoomPicks (657455752) | 3 | 627 |
  | Evolve (121679638) | 50 | 207 |
  | Outpost Vacation Rentals (499920268) | 6 | 41 |
  | Aspen Hotel Management Group (1673497466101215704) | 6 | 38 |
  | Casago Alaska Retreats (187849202) | 63 | 65 |

## Unknown accounts look like empty ones

A host id no account has (`1`, `999999999999`) returns `listings: []` with
no error: exactly what a real host with nothing listed returns (76492637,
whose only Anchorage listing had been deactivated). A malformed id
(`"abc"`) returns a GraphQL `ValidationError`.

So a failure that sent the wrong id, or a rotated hash that started
answering with empty lists, would read as hosts with zero listings rather
than as errors. `host_listings_cover_search` warns when more than 5% of
profiles read today list fewer listings than search saw under that host
today. In the full run, 4 of 1210 hosts' profiles held fewer listings than
they had active in the Municipality, 3 of them none; the profile drops a
deactivated listing at once, while an active listing stays active for
`RETIREMENT_GRACE_DAYS` after search last saw it.

## Cost

Measured by requesting every host from the 2026-09-25 run once, at `limit`
1000 and the shared 1.8 requests per second:

- **Requests:** 1211 for 1210 hosts: one each, and one retry. Reading the
  hotel chain's 1990 listings takes two more.
- **Time:** 672 seconds, about 11 minutes, set by the pacer: a request
  itself takes 250 to 700 ms, and 2.7 s for all three of the hotel chain's.
- **Errors:** none after retries. Two of 99 earlier unpaced requests, and
  one of the 1211, failed once with impit's `RemoteProtocolError` and
  succeeded on retry, the same transient failure the other passes retry
  through. No 429s.
- **Size:** the responses total 2.5 MB of JSON a day (the hotel chain's
  alone are 0.9 MB). Stored verbatim that is 3.7 MB a day in a DuckDB file,
  which barely compresses long strings. The same fields as columns take
  0.5 MB for the first day's 5110 rows. Stored change-only per listing, a
  later day adds only the listings whose fields changed: 7% of our own
  listings change their rating or review count on a given day, which would
  be about 360 rows, or about 70 KB.

## How it is stored

Every field of every entry goes into `airbnb_host_profile_listings`,
change-only per (host, listing), with a `listed = false` row when a listing
leaves a profile. Per listing rather than per host, because a large host's
profile has some listing with a new review nearly every day: stored per
host, 69% of the bytes would be rewritten daily; per listing, about 7%.

A response is stored verbatim instead, on the host's
`airbnb_host_observations` row, when the columns can't hold it: it doesn't
parse, or has a field or a value type not listed above. In the full run
that was none of them. `host_listings_parsed` warns when it happens.

## Not used

- **Airbnb's own page size.** The profile page asks for 12 at a time. 1000
  costs one request for every host here but the one hotel chain.
- **Verbatim storage of every response.** At 3.7 MB a day it would outgrow
  the rest of the published file within a week. The columns hold every
  field the response has today, and a response that has anything more is
  kept verbatim.
