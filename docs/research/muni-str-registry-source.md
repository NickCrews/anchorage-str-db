# A source for the Muni's STR registrations after the registry layer went private

Measured 2026-10-27 from the sandbox, anonymous requests. Concerns
`packages/scraper-muni-str`.

**Summary:** The ArcGIS service `ShortTermRental_Registrations_Hosted` now
answers `499 Token Required`: it was made private, not deleted, and no public
copy exists in the Muni's ArcGIS org or on its own ArcGIS server. CityView
license page ids come from one counter for every new license of any type, and
the first STR license is 13607, so reading every `License/Status` page from
13607 to the newest id and keeping the STR ones lists every STR license.
About 2,830 pages, ~25 minutes at the `muni-licenses` rate. The fields the layer
derived (coordinate, community council) can be rebuilt from public Muni
services, including the same geocoder.

## The old layer

```
https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/ShortTermRental_Registrations_Hosted/FeatureServer?f=json
-> {"error":{"code":499,"message":"Token Required"}}
```

The Experience Builder app item `22b40a78a9fc459e9950a16249b37ed2` returns 403.

## Other ArcGIS services: none have STR data

- **The Muni's ArcGIS Online org** (`services2.arcgis.com/Ce3DhLRthdwbHlfF`,
  336 public services). No service name or org item search matches rental,
  short term, STR, clerk or registration. The parcel layers used by
  [anchorage-property](https://github.com/NickCrews/anchorage-property)
  (`PropertyInformation_Hosted`, `MOA_Parcels_Hosted`, `TaxParcels_Hosted`)
  have no license fields. License layers exist for other types only:
  `LiquorLicenses_Hosted`, `MJ_Permits_Hosted`.
- **The Muni's ArcGIS Server** (`www.ancgis.com/arcgis/rest/services`, which
  the CityView portal map uses). `ITD/cityview_maporder2` has liquor, MJ and
  child care layers, no STR layer.
- **data.muni.org** redirects to a static open-data page.

## CityView License Locator: searchable, but capped at 40 results

`https://www.muni.org/CityViewPortal/License/Locator` is the portal's license
search. Its results come from a JSON endpoint that needs only the session
cookie from loading the Locator page:

```
GET /CityViewPortal/License/LocatorResults?searchValue=Echo+Ridge&jurisdictionFilter=&licenseType=&pageNumber=0
X-Requested-With: XMLHttpRequest
```

The response has `View` (an HTML list, 20 per page, with each license's
CityView `licenseId`) and `LocationMarkers`, one per located result:

```json
{
  "ReferenceNumber": "LC260902653",
  "Name": "Greenrose Rentals",
  "ApplicationTypeDescription": "Short-Term Rentals",
  "PrimaryLocation": "186 ECHO RIDGE DR, GIRDWOOD, AK 99587",
  "MapRelationValue": {"AttributeName": "Parcel_ID", "AttributeValue": "07606206000"},
  "Status": "Active",
  "LinkUri": "https://www.muni.org/CityViewPortal/License/StatusReference?referenceNumber=LC260902653&category=B"
}
```

It matches business name, address and license number, across all license
types (Alcohol, Business, Short-Term Rentals). A search for one exact license
or STR number returns a `RedirectUrl` to that license's Status page instead of
a list.

Every search stops at 2 pages, 40 results, newest license first: `*`, `AK` and
`ANCHORAGE` each return 40. `%` returns nothing. Listing everything this way
The JSON has fewer fields than the Status page: no STR number, issue or
expiry dates, description, or second parcel, and the CityView `licenseId` is
only in the `View` HTML. It does not replace parsing the Status page.

Listing everything this way needs many narrow searches (by street name, or by license number prefix,
splitting any that hit 40), and gives no signal that a search was complete
other than returning fewer than 40.

## Enumerating CityView license ids: complete

The Status page id (`License/Status?licenseId=N&category=B`) is a sequential
integer across license types. STR licenses start at 13607 (`STR20260004`
through `STR20260067` are at 13607-13609; 13600-13606 are invalid, and the lower ids seen are other types) and the
newest is 16439 (`STR20262782`, license `LC261002852`). Ids 16440-16460 are
invalid. The Locator's `*` search lists the newest licenses first, so its top
result gives the current upper end in one request.

A sample of every 10th id from 13607 to 16439 (284 pages):

| page | count |
| --- | --- |
| Short-Term Rentals, Active | 275 |
| Business, Active | 3 |
| "Invalid License" | 6 |

Every STR page in the sample had an STR certificate number. That projects to
about 2,750 STR licenses in the range. The layer had 2549 on 2026-09-07.

`packages/muni-licenses` already fetches and parses these pages, at 2/s. Its
`parseLicensePage` gives license number, business name, license type, status,
description, locations (parcel id and address) and issuances (STR number,
issued, expires, status). Reading the range is ~2,830 requests, ~25 minutes,
daily or weekly. Later runs can reread only ids above the last known maximum,
plus the existing range on a slower cycle to catch status changes.

### The ids are a running counter, not a batch

A second sample, every 20th id from 13607 to 16439 and every 40th from 9000
to 13606 (258 pages):

- Ids increase with the `LC` number's sequence (its last 5 digits) and with
  the issue date, with no exceptions. Issue dates run from 2026-05-01 at 13607
  to 2026-10-01 at 16407, about 2 ids a day after the May opening rush. The
  `LC` number's middle digits are the year and month the license was created
  (`LC2605...` is May 2026).
- Below 13607 there are no STR licenses: 13 Business, 1 Alcohol (e.g. 9480,
  `LC09603`), and 102 invalid.
- Business and Alcohol licenses are mixed into the STR range (3 of 284 in the
  first sample, and `LC261002840` and `LC261002830` among the newest).

So the id is CityView's counter for every new license of any type. The STR
range starts where the STR program started and stays mostly STR only because
STRs are most new licenses. A scan should run from 13607 to the newest id and
filter on license type, not assume every id is an STR.

Not known: what renewal does. Every STR issued so far expires 2027-04-30. A
renewal may add an issuance to the same license page, or create a new license
with a new id above the range. Either is covered by reading up to the newest
id, but a new license would split one rental's history across two ids.

### Ids follow creation, and some are hidden

100 consecutive ids, 16340-16439:

- Ids follow creation order, not issue order. Issue dates step back twice
  (16395 issued 2026-10-06, 16396 on 2026-09-30), so a license can be issued
  days after higher ids.
- 3 are "Invalid License": 16383, 16429 and 16430. Hidden ids are real
  licenses: 14417 sits between `LC260500839` and `LC260500841`, and the
  Locator finds no `LC260500840` either. The other categories (`A`, `C`, ...)
  return "not licensed" pages for every id, not the hidden license.

Whether a hidden id becomes visible later (an application not yet issued) or
stays hidden (withdrawn, denied) is not known. 14417 was still hidden five
months after its neighbors. 16429 and 16430 are a week old and worth
rechecking.

### Incremental reads

No id was seen reused or reassigned: each maps to one `LC` number, in order.
Remembering the highest id read is safe for finding new licenses, provided
each run:

- probes upward from the highest id until a run of consecutive invalid ids
  (or until the Locator's newest id),
- rereads ids known to be hidden, which may appear later below the maximum,
- rereads known licenses on the existing `LICENSE_PAGE_REFRESH_DAYS` cycle,
  since status, business name and issuances change on the same id.

At a 7-day refresh that is ~400 reads a day plus new and hidden ids, about the
current budget. A full pass is the fallback when state is lost.

The sample saw no inactive STR licenses, so how the portal shows a lapsed or
revoked STR is not yet known: either a non-`Active` status, or an "Invalid
License" page. Some of the 6 invalid ids may be one of those.

## What the layer had that license pages don't

| layer field | replacement |
| --- | --- |
| `RegistrationNumber`, `ApplicationNumber`, `BusinessName`, `Status`, `Issued`, `Expires`, `StatusUrl`, `Location` | on the license page |
| `Submitted` | none found |
| `GeocodedAddress`, coordinate | the same geocoder is public: `https://www.ancgis.com/arcgis/rest/services/Locators/MOA_Multirole_Locator/GeocodeServer/findAddressCandidates`. `525 w 3rd Ave #501, anchorage AK 99501` returns `525 W 3rd Ave, #501, Anchorage, AK, 99501` at (-149.89247, 61.21964), score 100. For a license with a parcel id, the parcel's polygon in `PropertyInformation_Hosted` is an alternative. |
| `CommunityCouncil` | point-in-polygon against `CommunityCouncil_Links/FeatureServer/0` (`COUNCIL`) |
| `ParcelType` | `Property_Type` in `PropertyInformation_Hosted`, by parcel id, for licenses that have one |
| `PUBDATE`, `dataLastEditDate` | none; the scrape time stands in |
| layer 1, `Clerk_ShortTermRental_CC_Stats` | living units per council: `PropertyInformation_LivingUnit_Summary` (public) |

The geocoder's output style may differ from the layer's (`#501` stayed `#501`
here, where the layer had `Apartment 501`), so `geocoded_address` values would
change on the switch.

## Options, ranked

1. **Enumerate license ids** with `muni-licenses`, then geocode and assign a
   council. Complete, uses a parser that exists and is tested, and adds what the
   layer lacked (description, all parcels). Costs ~2,830 requests per full pass.
2. **Locator searches.** Fewer requests per new license, but the 40-result cap
   makes completeness depend on the search plan. Useful as the cheap "what is
   the newest id" probe for option 1.
3. **Ask the Clerk** to make the layer public again, or for a token. Restores
   the old pipeline unchanged; depends on the Muni.

## Every license the portal publishes

Every 25th id from 1 to 16,520 (661 pages), 2026-11-10:

| id range | sampled | visible | Short-Term Rentals | Business | Alcohol |
| --- | --- | --- | --- | --- | --- |
| 1-13,606 | 545 | 43 | 0 | 31 | 12 |
| 13,607-16,520 | 116 | 109 | 109 | 0 | 0 |

That projects to about 2,750 STR, 750 Business and 300 Alcohol licenses, and
12,700 hidden ids. Only `category=B` is served; other categories return
"CityView PortalAnimalLicensing is not licensed" and similar.

- Business pages seen are private detective licenses (issuance number
  `PD 1476`, two-year terms ending 10/01). They have no Locations section,
  which `parseLicensePage` requires, so it throws on them (ids 9480, 13400,
  13580, 16427). Some list Submittals (`Private Detective`, 10/13/2026,
  Pending).
- Alcohol pages (id 559, `LC01867`) parse; their issuances have no dates or
  number.
- The page's "Application Status" was Active on every page sampled, including
  id 13400, whose only issuance expired 2025-10-01. The issuance status is the
  license's status.
