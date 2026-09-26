# Location data on Airbnb's listing page

Measured 2026-08-26 on Girdwood listings. Explains
`packages/scraper-airbnb/src/listingPage.ts`. See also
[`airbnb-address-deanonymization.md`](airbnb-address-deanonymization.md).

**Summary:** The listing page (PDP) says whether each listing's coordinate is
exact, via an `isExactLocation` boolean. It is `true` for roughly half of
Girdwood listings, whose coordinates are the host's published position. The
rest are jittered and can't be recovered. The page also carries the
Municipality of Anchorage STR registration id as a structured field.

## Where the data is

The search response gives a coordinate for every listing, stored as
`location_lat`/`location_lng`, but not whether it is exact.

The page at `airbnb.com/rooms/<id>` embeds its GraphQL response in
`<script id="data-deferred-state-0">`. The location object is at:

```
niobeClientData[0][1].data.node.pdpPresentation.location
```

Example (listing 715065, abridged):

```json
{
  "__typename": "StaysPdpLocation",
  "subtitle": "Girdwood, Alaska, United States",
  "latitude": 60.96564,
  "longitude": -149.13561,
  "isExactLocation": false,
  "defaultZoomLevel": 12,
  "exactAddress": null,
  "verificationDetails": {
    "isVerified": true,
    "verifiedHelpHtml": "This listing's location is verified and the exact location will be provided after booking."
  }
}
```

The same coordinate also appears in an analytics payload at
`presentation.stayProductDetailPage.sections.metadata.loggingContext.eventDataLogging.listingLat/Lng`.
The `LOCATION_DEFAULT` section is empty in the initial render.

pyairbnb's `get_details()` fetches this page but its standardizer drops the
coordinate object, so this project parses the page itself.

### schema.org JSON-LD

The page also has a `<script type="application/ld+json">` block for search
engines:

```json
{"@context": "https://schema.org", "@type": "VacationRental",
 "latitude": 60.96564, "longitude": -149.13561,
 "address": {"addressLocality": "Girdwood"}}
```

It is a public standard that Airbnb's search ranking depends on, so it is
unlikely to change shape. It has no `isExactLocation`.

### Parser layers

None of this is a documented API, so the parser extracts each field three
ways and records which worked in `ListingPage.locationSource` (in memory,
read by the quality checks, not stored):

| Layer | Source | Gives |
| --- | --- | --- |
| `json-ld` | schema.org block | coordinate |
| `state` | embedded GraphQL, found by shape | everything, including the flag |
| `raw-html` | regex over the raw document | flag, registration id |

The `state` layer does not use the path above. It searches every JSON script
for an object with a boolean key matching `exact…location` and reads the
coordinate and address from that object. Tested against a saved page, it
handles a renamed script id, renamed wrappers (`niobeClientData` →
`apolloState`, `pdpPresentation` → `pdpPresentationV3`), a renamed flag
(`isExactLocation` → `hasExactLocation`), a missing `type="application/json"`,
and unparseable JSON (falling back to `raw-html` for the flag and `json-ld` for
the coordinate). If all of these fail, the `extraction_layer_*_alive` and
`exact_location_flag_present` checks fail the run.

The `raw-html` layer returns nothing if a pattern matches more than one
distinct value. On the measured pages each pattern had one distinct match.

## Measurements

29 active listings sampled at random (seed 7), plus a separate 12, each
fetched once:

| Finding | Result |
| --- | --- |
| PDP coordinate vs. search coordinate | **identical for all 41** |
| Same listing fetched 4× over ~10 s | **identical** coordinates each time |
| `isExactLocation: true` | 13/29 (45%) and 7/12 (58%) |
| `exactAddress` non-null | 0/41 |
| `defaultZoomLevel` | 12 for all 41 |
| STR registration id present | 27/29 (93%) and 11/12 (92%) |

- **Repeated fetching doesn't reduce the jitter.** The offset is stored, not
  redrawn per request, as Airbnb's obfuscation patent (US 11,774,260) describes.
- **No source is more precise.** Search and PDP coordinates match exactly. The
  page adds the exact/jittered label, not precision.

### Decimal places match the flag

In all 41 listings, `isExactLocation` was `true` exactly when both latitude
and longitude had four or fewer decimal places, and `false` when they had five
or more. Exact coordinates appear to be rounded to 4 dp (~11 m) and jittered
ones emitted at 5 dp. Applied to 286 active listings at the time, this gave
136 (48%) exact, consistent with both samples.

This is undocumented and could change, so the pipeline stores the flag and
`exact_flag_matches_coordinate_precision` only warns on a mismatch.

### Registration id

The number appears in the long description under a `<b>Registration
Details</b>` heading, and as a `BasicListItem`:

```json
{
  "__typename": "BasicListItem",
  "title": "Registration Details",
  "html": { "htmlText": "STR20261897" }
}
```

Observed numbers match `STR2026\d{4}`. Hosts type them, and at least one was
`Str20261066`, so the parser ignores case and allows a separator. A number
means the host claims to be registered; the Municipal Clerk's registry is not
public, so it can't be verified.

At ~92% coverage a month after the 2026-07-31 display deadline, listings
without a number are the notable ones; see
[`docs/policy_questions.sql`](../policy_questions.sql).

## How the project uses this

The page fields are stored on the same `airbnb_listing_observations` row as the
search fields, so `location_is_exact` is next to the coordinate it describes.
They are part of the version key, so adding a registration id or changing
exact-location status opens a new version in `listings`. `page_seen_date` is
derived (the last scrape date with `page_fetch_ok`), so re-reading a page
daily does not open versions.

A failed page fetch stores `page_fetch_ok = false` and NULLs, and the view
carries the last successful read forward as a whole. Carrying the fields
together keeps "read the page, no number" distinct from "page not read", so a
failed fetch doesn't restore a number the host removed.

1. **About half of Girdwood listings can be matched to parcels.** Filtering the
   nearest-centroid query in `policy_questions.sql` on `location_is_exact`
   limits it to real coordinates, which at 4 dp fall inside the correct lot
   given Girdwood's parcel sizes.
2. **The other half stays unresolved.** Nothing here reverses the jitter; the
   registry remains the practical route.
3. **The registration id is the more useful field.** It answers the
   compliance question for ~92% of listings without an address.

## Ethics

Everything here is read from the public listing page. Exact coordinates are
ones the host chose to publish, and `isExactLocation` is Airbnb's statement of
which those are. The project makes no attempt to reverse the jitter.

## Reproducing

```sh
pnpm daily
```

```sql
SELECT location_is_exact, count(*), count(registration_id)
FROM listings WHERE is_active AND page_seen_date IS NOT NULL
GROUP BY ALL;
```
