# What Airbnb's listing page actually says about a listing's location

Measurement date: 2026-08-26. Companion to
[`airbnb-address-deanonymization.md`](airbnb-address-deanonymization.md),
which surveyed how *other people* attack this problem. This one is a direct
measurement of what Airbnb hands us for Girdwood listings, and what that
changes for this project.

Bottom line up front: **Airbnb tells you, per listing, whether the
coordinate it gave you is real.** The listing page (PDP) embeds a
`StaysPdpLocation` object with an `isExactLocation` boolean, and for
roughly half of Girdwood's listings it is `true` — those coordinates are
the host's actual position, published deliberately, with nothing to
de-anonymize. The remaining half are jittered and, as far as this
measurement goes, not invertible. Separately and probably more usefully,
the same page carries the **Municipality of Anchorage STR registration
number** as a structured field, which is the thing the prior research doc
recommended chasing (§Recommendation 6) over any geolocation work.

## How the coordinate reaches us

`pyairbnb.search_all()` — what `airbnb_client.search_anchorage()` calls —
returns `coordinates.latitude` / `coordinates.longitud` per result, and
that is what `listings.location_lat` / `listings.location_lng` (plain
`lat` / `lng` before the 2026-08 rename) have always held.

The listing page at `airbnb.com/rooms/<id>` server-renders its entire
GraphQL response into a single `<script id="data-deferred-state-0">`. The
location object lives at:

```
niobeClientData[0][1].data.node.pdpPresentation.location
```

and looks like this (listing 715065, abridged):

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

The same numbers also appear at
`presentation.stayProductDetailPage.sections.metadata.loggingContext.eventDataLogging.listingLat/Lng`
(an analytics payload), and the `LOCATION_DEFAULT` section itself is empty
in the initial render — the map loads lazily.

`pyairbnb.get_details()` fetches this exact page but its standardizer
(`pyairbnb/standardize.py`, `from_details`) keeps only the prose
`seeAllLocationDetails` blurbs from the location section and drops the
coordinate object entirely. That is why `listing_page.py` parses the page
itself rather than calling the library.

### The coordinate is also in schema.org JSON-LD

Alongside the private GraphQL blob, the page carries a public
`<script type="application/ld+json">` block that Airbnb publishes for
Google's rich results:

```json
{"@context": "https://schema.org", "@type": "VacationRental",
 "latitude": 60.96564, "longitude": -149.13561,
 "address": {"addressLocality": "Girdwood"}}
```

Same coordinate, in a standardized vocabulary that is load-bearing for
Airbnb's search ranking — which makes it far less likely to change shape
than an internal field. It does *not* carry `isExactLocation`.

### Which is why the parser is layered, not path-based

None of this is a documented API, so `listing_page.py` extracts three
independent ways and records which ones worked in
`ListingPage.location_source` (in-memory provenance, fed to the quality
gate rather than stored):

| Layer | Source | Gives |
| --- | --- | --- |
| `json-ld` | schema.org block | coordinate |
| `state` | embedded GraphQL, located by **shape** | everything, incl. the flag |
| `raw-html` | regex over the undecoded document | flag, registration number |

The `state` layer deliberately does *not* walk
`niobeClientData[0][1].data.node.pdpPresentation.location`. It searches
every JSON script on the page for an object carrying a boolean key
matching `exact…location`, then reads the coordinate and address keys off
whatever object that turns out to be. Verified against the real saved page,
this survives: a renamed script id, renamed wrapper keys
(`niobeClientData` → `apolloState`, `pdpPresentation` → `pdpPresentationV3`),
a renamed flag (`isExactLocation` → `hasExactLocation`), a dropped
`type="application/json"` attribute, and the JSON failing to parse at all
(it falls through to `raw-html` and keeps the coordinate from `json-ld`).
It breaks only if Airbnb renames the leaf fields *and* changes the wording
enough that the key patterns miss — at which point the
`extraction_layer_*_alive` and `exact_location_flag_present` checks fail the
run rather than letting nulls accumulate quietly.

The `raw-html` layer refuses to guess: if a pattern matches more than one
distinct value anywhere in the document, it returns nothing rather than
picking the first. On the measured pages each pattern had exactly one
distinct match.

## What was measured

A sample of 29 current listings drawn at random from the database
(seed 7), plus a separate 12-listing pass, each fetched once:

| Finding | Result |
| --- | --- |
| PDP coordinate vs. stored search coordinate | **identical for all 41**, to the last digit |
| Same listing fetched 4× over ~10 s | **byte-identical** coordinates every time |
| `isExactLocation: true` | 13/29 (45%) and 7/12 (58%) |
| `exactAddress` non-null | 0/41 |
| `defaultZoomLevel` | 12 for all 41 |
| STR registration number present | 27/29 (93%) and 11/12 (92%) |

Two things follow immediately:

- **There is no averaging attack.** The jitter is a stable stored value,
  not re-drawn per request, exactly as Airbnb's obfuscation patent
  (US 11,774,260, discussed in the companion doc §5) describes. Fetching a
  listing a thousand times yields the same point a thousand times.
- **There is no second, less-fuzzed surface.** Search and PDP agree
  perfectly, so scraping the listing page buys no extra precision. What it
  buys is the *label*.

### `isExactLocation` is legible in the coordinate itself

An unplanned but very clean side finding: across all 41 measured listings,
`isExactLocation` was `true` **iff** both latitude and longitude carried
**four or fewer decimal places**, and `false` iff they carried five or
more. 41/41, no exceptions.

That reads as two different code paths — an exact coordinate rounded to
4 dp (~11 m, roughly a parcel) and a jittered one emitted at 5 dp — and it
means the flag can be recovered retroactively from coordinates already in
the database, without re-fetching anything. Applying it to the 286 current
listings gives **136 (48%) exact-located**, consistent with both measured
samples.

Treat this as a useful cross-check, not as the source of truth: it is an
undocumented artifact of Airbnb's formatting that could change silently,
whereas `isExactLocation` is a field Airbnb maintains on purpose. The
pipeline stores the flag; the decimal-place rule is worth keeping in mind
mainly for interpreting the pre-2026-08 history, where no flag exists.

### The registration number is a structured field, not just prose

Airbnb renders the Anchorage STR number twice. Once inlined at the end of
the long description behind a `<b>Registration Details</b>` heading, and
once — better — as a `BasicListItem` in the description-modal section:

```json
{
  "__typename": "BasicListItem",
  "title": "Registration Details",
  "html": { "htmlText": "STR20261897" }
}
```

Observed numbers all match `STR2026\d{4}`, though hosts type them by hand
and at least one arrived as `Str20261066`, so the parser normalizes case
and tolerates a separator. A present number means the host *claims*
registration — verifying it against the Municipal Clerk's registry is a
separate step this project can't do yet (see the companion doc §6: the
registry isn't published as open data).

At ~92% coverage a month after the 2026-07-31 display deadline, the
listings *without* a number are the interesting rows — that query is in
[`queries/policy_questions.sql`](../../queries/policy_questions.sql).

## What this changes for the project

These fields are stored on `listings` itself rather than in a side table:
`location_is_exact` is a modifier on the `location_lat`/`location_lng`
columns sitting next to it, and splitting them would mean no query could
read a coordinate without remembering to join. They join `attr_hash`, so a
host toggling their exact location on or adding a registration number opens
a dated new version; `page_seen_date` is provenance and updates in place,
so re-reading the page daily doesn't grow a version per day.

1. **Roughly half of Girdwood's listings can be parcel-matched with
   confidence.** The nearest-centroid query in `policy_questions.sql`
   already existed but was, for the fuzzed half, matching Airbnb's random
   offset to whatever parcel happened to be nearby. Filtering on
   `location_is_exact` turns it from a coin flip into a defensible join —
   at 4 dp the coordinate is inside the right lot in a place with
   Girdwood's parcel sizes.
2. **The other half stays unresolved, and that's the right outcome.**
   Nothing here inverts the jitter, and the companion doc's conclusion
   holds: the tractable path for those is the registry, not a
   de-anonymization pipeline.
3. **The registration number is the higher-value field.** It answers the
   compliance question directly, for ~92% of listings, without needing an
   address at all.

## Ethical note

Everything above is read from the public listing page as a browser
receives it. The exact coordinates are the ones the host chose to publish;
`isExactLocation` is Airbnb's own statement of which those are, and
honoring it means this project *stops* treating fuzzed pins as locations
rather than starting to. No attempt is made to invert the obfuscation, and
per the companion doc §3c, none should be.

## Reproducing

```sh
uv run anchorage-str-db --db data/anchorage_str.duckdb daily
```

Then, to re-derive the table above:

```sql
SELECT location_is_exact, count(*), count(str_registration_id)
FROM listings WHERE is_current AND page_seen_date IS NOT NULL
GROUP BY ALL;
```
