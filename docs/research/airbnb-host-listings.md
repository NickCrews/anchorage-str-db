# A host's listings, from their profile

Measured 2026-09-26 against 52 hosts from the 2026-09-25 run. Explains
`packages/scraper-airbnb/src/api/hostListings.ts` and `hostListings.ts`, and
the `listings_on_airbnb` column of `airbnb_host_observations`.

**Summary:** `UserProfileBeehiveListingQuery`, the endpoint behind the
listings grid on `airbnb.com/users/show/<host id>` (and behind pyairbnb's
`get_listings_from_user`), returns every listing the host currently has
listed, wherever it is. It has no total count and paginates by offset, but
honours page sizes up to at least 1000, so one request covers almost every
host. It is the host listing portfolio that search cannot give us: of 48
hosts sampled, 15 list more than search saw here, and Evolve's
account holds 207 listings against 50 here.

## The request

A persisted GraphQL query, taken from pyairbnb 2.2.2 (`pyairbnb/host.py`):

```
GET https://www.airbnb.com/api/v3/UserProfileBeehiveListingQuery/529ca816b8be0619618d48b31bf46c379543e297fd68c0a953922927e5497b43
    ?operationName=UserProfileBeehiveListingQuery
    &locale=en&currency=USD
    &variables={"userId":"121679638","limit":100,"offset":0}
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

## Pagination

- **Offset and limit are both honoured.** Casago's 65 listings came back as
  12+12+12+12+12+5 at `limit` 12, and as 65 at `limit` 100 or 1000. Evolve's
  207 came back as 100 at `limit` 100 and all 207 at `limit` 1000.
- **No cap seen.** The largest account sampled (207) fit in one request at
  `limit` 1000. No Anchorage host is larger, so nothing here tests beyond
  that. `listHostListings` would page through a larger one, and throws after
  500 pages in case the offset is ever ignored.
- **Stable order.** The same ids came back in the same order at `limit` 12,
  50 and 100, so paging does not skip or repeat listings when nothing
  changes mid-way. A listing added between two requests would shift later
  pages by one, so ids are de-duplicated.
- **The end is a short page.** Offset 63 of Casago's 65 returned 2, and a
  request past the end returned an empty list for every host sampled. With
  `limit` 100, a host with under 100 listings costs exactly one request.

## What is on the profile

Compared against the Anchorage listings the 2026-09-25 run saw under the
same hosts:

- **Every listing search sees is on the profile.** 365 of 365 listings seen
  that day under 48 sampled hosts were on their host's profile. This is what
  the `host_listings_cover_anchorage` check tests.
- **Only listed listings.** Of 11 listings seen on 2026-09-24 but missing
  from search on 2026-09-25, 8 were still on their host's profile: search
  had dropped them for a day, which is why `RETIREMENT_GRACE_DAYS` exists.
  Two were gone from the profile, and their listing pages returned HTTP 410,
  so a deactivated listing leaves the profile. The last one had changed
  hands: its page named a new host (319033542, not 469671681), and it was on
  the new host's profile and gone from the old one's.
- **So inactive, unlisted or deactivated listings are not counted.** The
  count is what the host has listed today, not everything the account has
  ever held. It moves with delistings the same day, while `listings_active`
  waits out the grace period.
- **Listings everywhere.** 21 of 48 hosts listed more than search saw under
  them on 2026-09-25. For 6 of those, search saw none of their listings that
  day (it had dropped them); the other 15 hold more than search saw, mostly
  outside the Municipality. 15 hosts had exactly one listing in each. Some of the larger ones, against
  `host_listing_portfolios.listings_active` on 2026-09-25:

  | host | active in the Muni | on profile |
  | --- | --- | --- |
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
than as errors. `host_listings_cover_anchorage` fails the run when more than
5% of profiles read today list fewer listings than search saw under that
host today.

## Cost

- **Requests:** one per host with under 100 listings, plus one per extra 100.
  The 48 sampled hosts would cost 50. The 2026-09-25 run had 1210 distinct
  hosts, so about 1260 requests, which is about 12 minutes at the shared
  1.8 requests per second.
- **Latency:** 250 to 700 ms per request unpaced, and 1.5 s for the
  three-page account.
- **Errors:** 2 of 99 unpaced requests failed with impit's
  `RemoteProtocolError` and succeeded on retry, the same transient failure
  the other passes retry through. No 429s.

## Not used

- **Airbnb's own page size.** The profile page asks for 12 at a time. 100
  costs one request for all but the few largest managers and keeps each
  response small.
- **Listing ids.** The pass has them, but only the count is stored: without a
  location, the ids elsewhere can't be joined to anything in this database,
  and a list per host per day would grow the published file the viewer
  downloads.
- **The other fields.** Title, photo, rating and property type are available
  for listings outside Anchorage, but nothing asks for them yet.
