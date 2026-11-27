# The host id on Airbnb's listing page

Measured 2026-09-12 on 41 Girdwood listings. Written for the `hostId` extraction
in the former `packages/airbnb-client/src/listingPage.ts`. Airbnb's requests and parsing now live in [airbnb-dlp](https://github.com/NickCrews/airbnb-dlp). See also
[`airbnb-pdp-location-payload.md`](airbnb-pdp-location-payload.md) for the
page's structure and the three parser layers.

**Summary:** The listing page (PDP) names its primary host's Airbnb user id
twice, in two encodings. It is the id in `airbnb.com/users/show/<id>`, stable
for the life of the account. Co-hosts carry a different kind of id and are
not recorded.

## Where the id is

In the embedded GraphQL state (listing 715065, abridged):

```
niobeClientData[0][1].data.node.pdpPresentation.hostInfo.passportData
```

```json
{
  "__typename": "PassportCardData",
  "name": "Rachel",
  "userId": "RGVtYW5kVXNlcjozNjgyOTAx",
  "contextualUserId": "Q29udGV4dHVhbFVzZXI6MTQ2MjYzNjk3NDg0OTE5Nzc2MA==",
  "profilePictureUrl": "https://a0.muscache.com/im/users/3682901/profile_pic/1348681929/original.jpg"
}
```

`userId` is a GraphQL id, base64 of `DemandUser:3682901`.

The host-overview section's analytics context has the same number in decimal:

```
presentation.stayProductDetailPage.sections.sbuiData.sectionConfiguration.root.sections[2].loggingData.eventData.pdpContext
```

```json
{ "isSuperHost": "true", "hostId": "3682901" }
```

The schema.org JSON-LD block has no host.

## The host card

`passportData` is the host's profile card. Its parent, `hostInfo`, holds the
bio beside it. Measured 2026-09-12 on 2618 Anchorage listing pages (abridged):

```json
{
  "passportData": {
    "name": "Gwen",
    "userId": "RGVtYW5kVXNlcjoxMTE2NzU0ODY=",
    "timeAsHost": { "__typename": "TimeAsUser", "years": 9, "months": 7 },
    "stats": [{ "label": "Years hosting", "value": "10", "type": "YEARS_HOSTING" }]
  },
  "about": {
    "__typename": "UGCText",
    "source": "Mark and Gwen have lived in Alaska for 20 years. ...",
    "localizedString": "..."
  }
}
```

- `about` is `null` for a host with no bio.
- The "Years hosting" stat is rounded (9y7m shows "10", 5y10m shows "6"), so
  the parser stores `timeAsHost`.
- Airbnb publishes no start date. `timeAsHost` in whole months implies one
  up to a month late.
- `timeAsHost` appears once per page, so the `state` layer finds the card by
  that key. There is no `raw-html` fallback, because the bio can't be read
  reliably from undecoded HTML.

| Finding | Result |
| --- | --- |
| Pages with a host card | 2616/2618; the other 2 also had no host id |
| Card `userId` equals the page's host id | all 2616 |
| Distinct hosts | 1286 |

### Other user ids on the page

- `contextualUserId` and `node.contextualPrimaryHost.id` decode to
  `ContextualUser:<19 digits>`. It was the same across one host's listings in
  the sample, but it is a separate number space from the account id and does
  not appear in profile URLs.
- `node.cohosts[]` lists co-hosts as `ContextualUser`s with a first name and
  photo, and no `DemandUser` id.
- The profile photo URL contains the account id for older accounts
  (`/im/users/3682901/`) but not newer ones (`/im/pictures/user/<uuid>.jpg`).

## Parser layers

| Layer | Finds |
| --- | --- |
| `state` | the one string anywhere in a JSON script that base64-decodes to `DemandUser:<digits>`; null if there are several distinct ids |
| `raw-html` | the one distinct value of `"hostId":"<digits>"` in the raw document |

The two read different fields in different encodings, so a change to one
leaves the other working. Both ignore key names and paths except the
`hostId` key itself.

## Measurements

| Finding | Result |
| --- | --- |
| Pages with a `DemandUser` id | 41/41, exactly one distinct id each |
| Pages with a `"hostId"` | 41/41, exactly one distinct value each |
| `DemandUser` id equals `hostId` | 41/41 |
| Pages with co-hosts | 9/41; none added a second `DemandUser` id |
| Distinct hosts | 32 across the 41 listings |
| Longest id | 19 digits (`1726975321647428715`), within `BIGINT` |

## How the project uses this

`host_id BIGINT` is a page field on `airbnb_listing_observations`, so it is part of
the carried-forward `page_attrs` and of the version key: a room changing
hosts opens a new version in `listings`. The `host_id_coverage` check fails
the run when fewer than `MIN_PAGE_FIELD_SHARE` of active, page-read listings
have one. The host card populates `airbnb_host_observations`; see README.
