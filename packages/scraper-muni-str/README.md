# `@anchorage-str-db/scraper-muni-str`

A client for the Muni's ArcGIS FeatureServer layers, in memory.

`arcgis.ts`:

- `fetchLayer(layerUrl, options)`: every feature in a layer, all fields. A
  query returns at most the layer's `maxRecordCount` features, so it pages
  with `resultOffset` in `OBJECTID` order until the server stops reporting
  `exceededTransferLimit`, then compares the total with a `returnCountOnly`
  query and throws on a mismatch.
- `liveJsonFetcher(options)`: real requests, paced and retried. ArcGIS
  reports most errors as HTTP 200 with an `error` body; those are thrown and
  retried.
- `fetchLayerDataEditedAt` and `epochMsToTimestamp`: a layer's
  `editingInfo.dataLastEditDate`, and ArcGIS dates as naive UTC timestamps.

The Municipal Clerk's STR registration layer
(`ShortTermRental_Registrations_Hosted/FeatureServer`) answers only with a
token. What it published is archived in `muni_str_registration_observations`
(see `packages/db`); registrations are read from the CityView license pages
(`packages/muni-licenses`, `packages/licenses`).

## Tests

`test/arcgis.test.ts` tests paging and the count check against a fake
server, without the network.
