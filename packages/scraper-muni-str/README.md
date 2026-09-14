# `@anchorage-str-db/scraper-muni-str`

Fetches the Municipality of Anchorage's short-term rental registrations, in
memory. `packages/scraper` stores them.

The source is the Municipal Clerk's
[Short Term Rental Registration Viewer](https://experience.arcgis.com/experience/22b40a78a9fc459e9950a16249b37ed2),
an ArcGIS Experience Builder app over a public FeatureServer:

```
https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/ShortTermRental_Registrations_Hosted/FeatureServer
```

Layer 0, `Clerk_ShortTermRental_Reg`, has one point per registration (2549
on 2026-09-07). `fetchRegistrations()` returns them as `Registration`
records, plus the layer's `editingInfo.dataLastEditDate`.

Layer 1, `Clerk_ShortTermRental_CC_Stats`, holds the Muni's registration
and living-unit counts per Community Council. It is not fetched.

## Fetching

A query returns at most `maxRecordCount` (2000) features, so `fetchLayer`
pages with `resultOffset` in `OBJECTID` order until the server stops
reporting `exceededTransferLimit`, then compares the total with a
`returnCountOnly` query and throws on a mismatch. ArcGIS reports most errors
as HTTP 200 with an `error` body; those are thrown and retried.

## What the layer contains

- Every registration has `Status` `Active`; lapsed ones are
  removed rather than marked. Every `Expires` is `2027-04-30`.
- `RegistrationNumber` is `STR` + 8 digits, the same value Airbnb listings
  show. `ApplicationNumber` (`LC` + 9 digits) is the license's "Licensee
  Number".
- `StatusUrl` links to the license's CityView page, read by
  `muni-licenses`.
- `Location` is the address on the license. When the license is tied to a
  Muni property record (its CityView page links the parcel id and address
  to the portal's property search), `Location` is that record's address in
  the parcel-address style: `7730 MAYFAIR DR, Unit:APT 1, ANCHORAGE, AK
  99502`, or `311 MELODY PL` when the record has no city. Otherwise it is
  the applicant's typed text: `525 w 3rd Ave #501, anchorage AK 99501`.
  Several registrations can share one address (units of a building).
- `BusinessName` is the string `'None'` when none was given.
- `GeocodedAddress`, the point, `CommunityCouncil` and `ParcelType` are
  derived from `Location` by the Muni, not given by the applicant.
  `GeocodedAddress` is the geocoder's reading in its own style (`7821 Mayfair
  Dr, Apartment C, Anchorage, Alaska, 99502`), and it rewrites typed text
  too (`#501` becomes `Apartment 501`). A `Location` with no city or zip
  gets `'Incomplete address provided. No Match.'`, the placeholder point
  (-150.20935, 61.153442), and no council or parcel type (11 registrations).
  `CommunityCouncil` is null exactly for those. `ParcelType` can also be null
  for an address that geocoded and a license that names its parcel.
- `PUBDATE` is the date of the Muni's last publish, about weekly.

Values are returned as published; `packages/scraper`'s views do the cleaning.

## Tests

`test/addresses.test.ts` reads the live layer and checks the rules above
across every registration, with examples. `test/registrationLayers.test.ts`
tests paging and field conversion without the network.
`packages/scraper/test/addressProvenance.test.ts` checks `Location` against
the license pages.
