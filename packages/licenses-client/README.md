# `@anchorage-str-db/licenses-client`

Fetches and parses the Municipality of Anchorage's CityView license status
pages, in memory. `packages/licenses-scraper` chooses which to read and stores them.

```
https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B
```

`licenseId` is one counter across every license type, in creation order.
Visible pages include Short-Term Rentals, Business (private detectives) and
Alcohol licenses. A Short-Term Rentals license's page has what the
Municipal Clerk's registration layer lacked:

| field | example |
| --- | --- |
| `licenseId` | `LC260500349` (the layer's `ApplicationNumber`); one per license, not per licensee |
| `businessName` | `Echo Ridge Mountain Retreat` |
| `licenseType` | `Short-Term Rentals`, `Business`, `Alcohol` |
| `status` | `Active`: the page's "Application Status", `Active` on every page sampled, even one whose only issuance expired (13400); an issuance's status is the license's |
| `description` | `Provides short term rentals, logistics, meeting space and overnight lodging.` |
| `locations` | `Property` `07606227000` (parcel id), `Address` `257 ECHO RIDGE DR, GIRDWOOD, AK 99587`; empty when the page has no Locations section |
| `issuances` | `STR Certificate`, issued 2026-05-04, expires 2027-04-30, `Active`, `STR20260309` |
| `submittals` | `1 Private Detective 10/13/2026`, `Private Detective`, 2026-10-13, `Pending`; empty when the page says "There are no submittals for this license application." |

Most ids are hidden license ids: HTTP 200 with an "Invalid License" page
headed "License Not Found". That page parses to `{ hidden: true,
cityviewLicenseId }`, a result rather than an error; a visible page has
`hidden: false`.

| export | does |
| --- | --- |
| `fetchLicensePages(cityviewLicenseIds)` | reads pages one at a time at up to `REQUESTS_PER_SECOND` (1/s) and returns a result per id: the page (visible or hidden), or the error when the read failed |
| `parseLicensePage(html, cityviewLicenseId)` | the parser alone: `LicensePage \| HiddenLicensePage` |
| `fetchNewestCityviewLicenseId()` | the newest id, from the License Locator |
| `parseNewestCityviewLicenseId(json)` | the Locator parser alone |

## The newest id

The License Locator lists licenses newest first, 20 to a page. Its results
(`/CityViewPortal/License/LocatorResults?searchValue=*&...&pageNumber=0`,
with `X-Requested-With: XMLHttpRequest`) answer only within a session: the
Locator page (`/CityViewPortal/License/Locator`) sets the cookies, and
without them the results redirect to a session-expired page. The response
is JSON whose `View` is the list's HTML; each item links its "License
Status" page. The newest id is the highest `licenseId` on the first page,
not the first item's: on 2026-11-10 the list began with 559, an Alcohol
license, then 16459, 16458, ...

## Parsing

Fields are found by the text a reader sees, using `node-html-parser`: a
summary value by its label ("Business Name:"), a section by its heading
("Locations"), a table column by its header ("Date Issued"). Element ids
and CSS classes are not used. A missing label, heading or column throws, so a
markup change fails the read rather than storing NULLs. The Locations
section is the exception: a page may have none.

A submittal's date is not a column; it is the `MM/DD/YYYY` date ending the
name the portal shows (`1 Private Detective 10/13/2026`).

Text is kept as shown: entities decoded, ends trimmed, and line breaks and
repeated spaces inside a description kept. The portal sends CRLF line
endings, which are normalized to LF as a browser does.

Cases the parser handles, each read from the real portal by
`test/licensePage.test.ts`:

| license | case |
| --- | --- |
| 13923 | every field: a labeled parcel id and address, one issuance |
| 15993, 13664 | an address typed as free text, with no label or link |
| 13990 | a labeled address followed by a free-text parcel id |
| 13613 | an address with no parcel |
| 13640 | two parcels and an address |
| 13966 | the portal's own error message in place of a label (`Error: Syntax error: Missing operand after 'SWAY' operator.`, from the apostrophe in WENDY'S WAY) |
| 13939, 13613 | a description with paragraph breaks or double spaces |
| 13623, 13625 | `&` and a curly apostrophe in the business name |
| 16427 | a Business license: no Locations section, an `Issued` issuance, a submittal |
| 13400, 9480, 13580 | Business licenses with no Locations section; 13400's only issuance is `Expired` while the page says `Active` |
| 13270 | a submittal with an empty type (`1 06/06/2023`) |
| 559 | an Alcohol license: an `* Address` label, a free-text parcel id, an issuance with no dates or number |
| 50, 14417 | hidden license ids: the "Invalid License" page |

The locations rule: an item linking to the portal's property search is a
value, and an unlinked item just before it is its label. Every other item is
a value with a null label. Each value keeps its `link`: a linked value comes
from the Muni's property records (a parcel id, or the record's address, which
is the registration layer's `Location`); an unlinked value is text the
registrant typed that matched no record.

## Pacing

Plain `fetch` works through the portal's Cloudflare front. A page takes
~0.5s. From GitHub's runners the front answers HTTP 429 to about half of the
requests sent at 2/s, so pages are read one at a time at 1/s. A 429 is a
signal to slow down, not a failure: it halves the request rate (down to
0.25/s) and the read is retried after 10s, then 20s, or after the response's
`Retry-After` when that is longer, up to a minute. A read fails only once its
3 attempts are spent. After 20 successes in a row the rate rises by a
quarter, back up to 1/s. A streak of timeouts also halves the rate. This is
the default policy of `Pacer` (`utils/pace`); the License Locator requests
share the same pacer.

## Tests

`pnpm test` in this package reads the pages above and the License Locator
from the live portal, about 30 requests. The expected values are the pages
as of 2026-09-14 (Short-Term Rentals) and 2026-11-10 (the rest); a failure on
one field can also mean a licensee edited their license.
`test/newestLicenseId.test.ts` runs offline: which id the Locator parser
takes from a response, and what it rejects. So does `test/rateLimit.test.ts`,
with `fetch` stubbed: a 429 slows the pacer and is retried, and a read fails
only once every attempt was refused.
