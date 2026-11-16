# Room type, room counts and photos on Airbnb's listing page

Measured 2026-09-12 on 44 listings from three Anchorage-area search pages,
chosen to cover every property kind the searches returned (homes, rooms,
shared rooms, hostels, tents, RVs, domes, apartments, …). Explains those
fields' extraction in `packages/airbnb-client/src/listingPage.ts`. See
[`airbnb-pdp-location-payload.md`](airbnb-pdp-location-payload.md) for the
page's structure and the three parser layers.

**Summary:** The listing page (PDP) the daily run already fetches has all of
them, so they cost no extra requests. Guest capacity and bed count are
integers; room type, bedrooms and bathrooms exist only as display text and
are stored verbatim. The search response has no room type or guest count,
and its bath line is unreliable.

## Search cards

`structuredContent.primaryLine` holds only `BEDINFO` and `BATHROOMINFO` lines,
e.g. `1 bedroom | 1 queen bed | 1 bath`. On 120 cards:

- No card has a guest line.
- `title` (stored as `property_title`) is a property type plus a town:
  `Room in Anchorage`, `Guesthouse in Anchorage`, `Hostel in Girdwood`. It is
  not a room type: of the sampled pages, both `Guesthouse` listings and the
  `Hostel` listing are private rooms, and `Rooms in Anchorage` is a private
  room in a six-bedroom house.
- For a private room the bath line describes the whole house (`2 baths`),
  where the page describes the guest's bathroom (`Shared bathroom`).
- A card can omit the bath line on some days and not others (#28).
- Bed lines include a bed type (`1 queen bed`, `3 bunk beds`), and 3 of 120
  cards had none.

## Where each field is on the page

All paths are under `niobeClientData[0][1].data`.

| Field | Path | Values seen |
| --- | --- | --- |
| Room type | `presentation.stayProductDetailPage.sections.metadata.loggingContext.eventDataLogging.roomType` | `Entire home/apt` 31, `Private room` 11, `Shared room` 2 |
| Guest capacity | `…sections[].section.shareSave.embedData.personCapacity`, also `node.personCapacity` and `maxGuestCapacity` | 1–16 |
| Bed count | `node.bedCount` (`DemandStayListing`) | 0–15 |
| Overview | `node.pdpPresentation.overview.items` (`StaysPdpOverview`) | `["5 guests", "2 bedrooms", "3 beds", "1 bath"]` |
| Photos | `…sections[].section.mediaItems[].baseUrl` | 6–78 per listing, median 17 |

Each page had exactly one distinct value for `roomType`, `personCapacity` and
`bedCount`, one overview, and one `mediaItems` list. No page has a bedroom or
bathroom count anywhere except the overview's text.

`propertyType` is also present, twice: an enum (`HOUSE`, `TENT`, `HOSTEL`) and
a display string (`Private room in hostel`, `Entire cabin`). It is not stored.

`Hotel room` did not occur in the sample. It is Airbnb's fourth room type and
appears in Airbnb's public listing exports, so it is in the vocabulary.

### Guest capacity

`personCapacity` is used, not the overview's guest line or JSON-LD:

- The overview caps its line at `16+ guests`, and private and shared rooms
  omit it (`["1 queen bed", "Shared bathroom"]`).
- JSON-LD `containsPlace.occupancy.value` differs from `personCapacity` on
  most listings and tracks the bed count (a 5-guest, 3-bed home has
  `occupancy` 3).

### Beds

`bedCount` matched the overview's bed line on 40 of 44 pages. The other four:
two shared rooms with `3 bunk beds` have `bedCount` 6, and an RV and a cabin
with no bed line have 0.

### Bedrooms and bathrooms

Stored as the overview line, verbatim. The parser picks the line containing
`bath` as bathrooms, and the one containing `bedroom` or `studio` as bedrooms.

Bathroom lines on the 44 pages: `N bath(s)`, `0 baths`, `N shared bath(s)`,
`N shared bathrooms`, `Half-bath`, `Shared half bathroom`, `Shared bathroom`,
`Dedicated bathroom`. Earlier samples (#28) also had `N private bath` and
`Private attached bathroom`. Every page had one.

Bedroom lines: `N bedroom(s)` and `Studio`, on 33 of 44 pages. Private and
shared rooms usually have none, as did an RV, a campsite and a camper.

### Photos

JSON-LD `image` lists at most 8 photos, so it is not used: a fallback to it
would store a different set whenever the `state` layer failed. URLs look like
`https://a0.muscache.com/im/pictures/hosting/Hosting-<id>/original/<uuid>.jpeg`
(older uploads: `…/im/pictures/<uuid>.jpg`), with no signature or expiry
parameter. A URL stops working when the host removes that photo. The CDN
resizes via `?im_w=240`.

## Parser layers

| Field | `state` | `raw-html` |
| --- | --- | --- |
| `roomType` | the one distinct `roomType` string | the one distinct `"roomType":"…"` |
| `guestCapacity` | the one distinct `personCapacity` number | the one distinct `"personCapacity":N` |
| `beds` | the one distinct `bedCount` number | the one distinct `"bedCount":N` |
| `bedrooms`, `bathrooms` | the matching line of an `items` string list | the same, from `"items":[…]` lists |
| `photoUrls` | the longest `mediaItems` list's `baseUrl`s, de-duplicated | none |

On all 44 pages the `state` layer produced every field the page had, and
`raw-html` alone produced the same values.

## Storage

Room type and the room counts are page fields on
`airbnb_listing_observations`: carried forward across a failed page fetch, and part
of the version key.

Photos are in `airbnb_listing_photos`, one row per listing per distinct ordered set.
Benchmarked with the pipeline's own `recordObservations`, 2,600 listings × 30
days using the sampled galleries, with 5% of galleries changing mid-month:

| Layout | File size |
| --- | --- |
| No photos | 8.4 MB |
| `airbnb_listing_photos` (2,694 rows) | 14.7 MB |

The ~6 MB is mostly the first set per listing; after that the table grows
only with gallery changes. An array on every daily observation row would
repeat each gallery 30 times a month.
