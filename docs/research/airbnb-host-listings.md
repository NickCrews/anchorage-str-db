# A host's listings, wherever they are

Measured 2026-09-29 against live Airbnb, using the 1226 hosts with an active
listing in the 2026-09-27 run. Explains `hostListings.ts` and
`packages/scraper-airbnb/src/api/hostListings.ts`.

**Summary:** A host's public profile lists every listing they hold, in any
market, and one GraphQL endpoint pages through that list. It returns no total,
so the count is the length of the list. With 100 per page, the 1226 Anchorage
hosts took 1253 requests and 11.6 minutes at the shared request rate, with no
failures. The Anchorage hosts hold 6116 listings between them, 2.5 times the
2473 active listings they hold inside the Municipality.

## The endpoint

`UserProfileBeehiveListingQuery` (persisted-query hash `529ca816…497b43`,
taken from pyairbnb's `get_listings_from_user`) with
`{"userId": "<host id>", "limit": <n>, "offset": <n>}`. It needs the web API
key and nothing else: no cookies or session. For host 3682901 (abridged):

```json
{
  "data": {
    "beehive": {
      "getListOfListings": {
        "listings": [
          {
            "id": "33153126",
            "nameOrPlaceholderName": "Surrey room-King bed-Ensuite bath-Woodland view",
            "localizedRoomType": "Private room",
            "reviewCount": "1",
            "ratingAverage": 1.0
          }
        ]
      }
    }
  }
}
```

The listing id is all the pass reads. There is no total count, cursor, or
"has more" flag, and nothing in the entry says where the listing is.

## Findings

| Question | Result |
| --- | --- |
| Is there a total? | No. `getListOfListings` has only `listings`. |
| Does it paginate? | Yes, by `offset`/`limit`. Pages at `limit` 12 and 100 gave the same 206 ids for host 121679638, in the same order, with no repeats. |
| Is `limit` capped? | Not below 206: `limit` 12, 20, 50 and 100 each returned that many, and 500 returned all 206. A host with 1990 listings took 20 requests at 100. |
| Does it cover other markets? | Yes. Host 121679638 lists 206; 50 are active here. |
| Does it include every Anchorage listing? | For the 8 largest Anchorage hosts, every active listing here was on the profile. Across all 1226, 1216 listed at least as many as were active here on 2026-09-27. Each of the other 10 was short by exactly its listings that returned HTTP 410 (delisted) by the time of the read. |
| Inactive or unlisted rooms? | Not observable from outside: a delisted listing (HTTP 410) is absent from its host's list. The archive had no inactive listings to compare yet. |
| An account that doesn't exist | An empty list, not an error (ids 1 and 999999999999). |
| A 19-digit host id | Must be sent as a string. As a JSON number it loses precision, names another account and returns an empty list. |

The empty list for a missing account means a wrong id reads as a host with
no listings. The `host_listings_cover_anchorage` check catches that: it warns
when fewer than 95% of hosts read list at least as many listings as were seen
under them that day.

## Distribution

Listings per host, 2026-09-29:

| Listings | Hosts, anywhere | Hosts, in Anchorage |
| --- | --- | --- |
| 0 | 7 | — |
| 1 | 736 | 879 |
| 2–4 | 356 | 263 |
| 5–9 | 75 | 60 |
| 10–49 | 43 | 21 |
| 50–99 | 6 | 3 |
| 100+ | 3 | 0 |

- 256 hosts hold more listings than they hold here; 138 of them have one
  listing here and at least two elsewhere.
- The three largest hosts hold 1990, 627 and 206 listings, and 6, 3 and 50 of
  them are here.
- Hosts with 10+ listings in Anchorage hold 22.8% of the Anchorage listings
  attributed to a host. Hosts with 10+ listings anywhere hold 28.8%.

## Cost

Every host needs one request, plus one per further 100 listings. Only the
three 100+ hosts needed more: 3, 7 and 20 requests. Responses came back in
about 0.3 s, so the pass is bound by the shared rate in `pace.ts`, not by
latency: 1253 requests at 1.8/s is 11.6 minutes. See CONTRIBUTING's "Request
budget".

## How the project uses this

The host pass reads each host named by the day's listing pages once and
stores the count as `airbnb_host_observations.listings_anywhere`, with
`listings_anywhere_read_ok`. `host_listing_portfolios.listings_anywhere` is
the latest successful read on or before each date. Only the count is stored,
not the listing ids, and no threshold or label is derived from it.
