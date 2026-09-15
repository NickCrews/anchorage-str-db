# `@anchorage-str-db/muni-licenses`

Fetches and parses the Municipality of Anchorage's CityView license status
pages, in memory. `packages/scraper` chooses which to read and stores them.

```
https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B
```

Each STR registration in `scraper-muni-str` links to one. The page has what
the registration layer lacks:

| field | example |
| --- | --- |
| `licenseId` | `LC260500349` (the layer's `ApplicationNumber`); one per license, not per licensee |
| `businessName` | `Echo Ridge Mountain Retreat` |
| `licenseType` | `Short-Term Rentals` |
| `status` | `Active` |
| `description` | `Provides short term rentals, logistics, meeting space and overnight lodging.` |
| `locations` | `Property` `07606227000` (parcel id), `Address` `257 ECHO RIDGE DR, GIRDWOOD, AK 99587` |
| `issuances` | `STR Certificate`, issued 2026-05-04, expires 2027-04-30, `Active`, `STR20260309` |

`fetchLicensePages(cityviewLicenseIds)` reads pages at `REQUESTS_PER_SECOND` (2/s)
and returns a result per id, with the error rather than a page when a read
failed. `parseLicensePage(html, cityviewLicenseId)` is the parser alone.

## Parsing

Fields are found by the text a reader sees, using `node-html-parser`: a
summary value by its label ("Business Name:"), a section by its heading
("Locations"), an issuance column by its header ("Date Issued"). Element ids
and CSS classes are not used. A missing label, heading or column throws, so a
markup change fails the read rather than storing NULLs.

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
| 50 | an unknown id: HTTP 200 with an "Invalid License" page, which throws |

The locations rule: an item linking to the portal's property search is a
value, and an unlinked item just before it is its label. Every other item is
a value with a null label. Each value keeps its `link`: a linked value comes
from the Muni's property records (a parcel id, or the record's address, which
is the registration layer's `Location`); an unlinked value is text the
registrant typed that matched no record.

Plain `fetch` works through the portal's Cloudflare front. A page takes
~0.5s. A first batch of 1000 pages at 2/s had no failures; a second batch of
1000 started 15 minutes later began timing out partway through, the pacer
backed off to 0.5/s, and 2 reads failed.

## Tests

`pnpm test` in this package reads the pages above from the live portal, about
20 requests. The expected values are the pages as of 2026-09-14; a failure on
one field can also mean a licensee edited their license.
