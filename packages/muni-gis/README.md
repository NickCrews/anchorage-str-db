# `@anchorage-str-db/muni-gis`

Clients for the Muni's ArcGIS services, in memory: feature layers, the
address geocoder and community councils. A provider
like `muni-licenses`: it returns typed records and never touches DuckDB;
`packages/licenses` decides what is stored.

`arcgis.ts`:

- `fetchLayer(layerUrl, options)`: every feature in a layer, all fields. A
  query returns at most the layer's `maxRecordCount` features, so it pages
  with `resultOffset` in `OBJECTID` order until the server stops reporting
  `exceededTransferLimit`, then compares the total with a `returnCountOnly`
  query and throws on a mismatch.
- `liveJsonFetcher(options)`: real requests, paced and retried. ArcGIS
  reports most errors as HTTP 200 with an `error` body; those are thrown and
  retried. `liveMuniArcgisFetcher()` is one for the Muni's ArcGIS Online
  services at 2 requests a second.
- `fetchLayerDataEditedAt` and `epochMsToTimestamp`: a layer's
  `editingInfo.dataLastEditDate`, and ArcGIS dates as naive UTC timestamps.

`geocoder.ts`, the Muni's `MOA_Multirole_Locator`
(`www.ancgis.com/.../GeocodeServer/findAddressCandidates`), the locator the
archived registration layer was geocoded with:

- `liveGeocoder()` and `geocodeAddresses(addresses)`: each address's best
  candidate (`matchedAddress`, `lat`, `lng`, `score`, `matchType`), or null
  when the locator has none; a failed request is recorded in its result. 4
  requests a second.
- `isAddressMatch(candidate)`: a candidate is a match when its `Addr_type`
  places the address itself (`PointAddress`, `Subaddress`, `StreetAddress`)
  and it scores at least 90, the locator's own `MinimumMatchScore`. The
  locator also answers with the street alone (`StreetName`) at up to 100, so
  the score cannot tell those apart by itself.
- `geocoderQuery(address)`: the text sent. It drops the `Unit:` of the
  Muni's parcel-address style (`5500 ALORA LOOP, Unit:COND 29, ...`), which
  the locator cannot read.

Against 410 addresses from the archived registration layer (2026-11-10)
every match was a `PointAddress` or `Subaddress` scoring 96.67 or more, a
median 13 m and at most 80 m from the layer's own coordinate, and the
addresses the layer could not match for lack of a city (`311 MELODY PL`)
matched. The misses are typed addresses with a room or the street written
twice after them.

`councils.ts`: `fetchCommunityCouncils()` reads the 39 polygons of
`CommunityCouncil_Links/FeatureServer/0` (field `COUNCIL`), and
`councilAt(councils, lat, lng)` names the one containing a coordinate, by
even-odd ray casting (`utils`' `inRings`), or null. The polygons do not
overlap: each of the archive's 2,564 geocoded coordinates fell in exactly
one, the council the layer named.

The Municipal Clerk's STR registration layer
(`ShortTermRental_Registrations_Hosted/FeatureServer`) answers only with a
token. What it published is archived in `muni_str_registration_observations`
(see `packages/db`); registrations are read from the CityView license pages
(`packages/muni-licenses`, `packages/licenses`).

## Tests

`test/arcgis.test.ts` tests paging and the count check against a fake
server. `geocoder.test.ts` and `councils.test.ts` test parsing, matching
and council lookup offline, and each ends with a test against the live
service, so they fail when the Muni changes one.
