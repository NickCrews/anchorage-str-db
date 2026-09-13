# `src/arcgis`: the ArcGIS Feature Service REST API

Unlike `packages/scraper/src/airbnb/`, this is a documented, versioned,
public API: [Esri's Feature Service
reference](https://developers.arcgis.com/rest/services-reference/enterprise/feature-service/).
There is no persisted-query hash to rotate, no TLS fingerprinting, and no
rate limit to pace against — a whole run is a handful of requests.

| file | endpoint | what it is |
| --- | --- | --- |
| `http.ts` | — | the shared POST-and-parse client |
| `layer.ts` | `GET <layer>?f=json` | the layer's fields, object-id field, page size, and last-edit time |
| `query.ts` | `POST <layer>/query` | object ids, then the records for a batch of them |

What the protocol gets wrong, and what this directory does about it:

- **An error can arrive with HTTP 200.** A bad field name or a layer that
  wants a token is `{"error":{"code":400,...}}` in an otherwise fine
  response. `requestJson` raises those as `ArcGisError`, so no caller parses
  an error object as data.
- **A response can be silently short.** A query over the server's size budget
  returns as many rows as fit and sets `exceededTransferLimit`, which is easy
  to ignore. `queryByObjectIds` names the rows it wants and counts what came
  back, so a truncated batch raises `IncompleteResponseError` instead of
  reading as a registry that shrank.
- **`maxRecordCount` is advisory.** The real limit is a response-size budget,
  so a layer with long strings truncates below its own declared page size.
  `extract.ts` halves the batch and carries the smaller size forward.
- **Offset paging is not stable.** `resultOffset` re-runs the query for each
  page, so an edit between two pages shifts the rows after it and one is
  skipped or returned twice. Reading the object ids first pins the extract to
  one set of rows — see the `query.ts` docstring.
- **Dates are epoch milliseconds, always UTC.** `fromEsriDate` in `dates.ts`
  takes the UTC calendar day. A registration's issue date is a day, not an
  instant; whatever local midnight or noon the publisher wrote, the UTC day
  is the only reading that invents no timezone.

Requests are POSTed rather than GETed because `queryByObjectIds` sends a few
thousand object ids, which is longer than servers accept in a URL.
