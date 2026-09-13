# The municipal STR registry as a data source

What Anchorage publishes about short-term rental registrations, how to reach
it, and how often it moves. Background for
[`docs/proposals/muni-registry-integration.md`](../proposals/muni-registry-integration.md)
and for `packages/registry`.

## The program

[AO 2025-115(S-2)](https://www.muni.org/Departments/Assembly/Clerk/Licensing/Pages/Short-Term-Rental-Registration-Program.aspx),
passed by the Assembly in December 2025, requires every short-term rental in
the Municipality to register with the Clerk's office, and requires the
registration number to appear in the listing or advertisement **on any
platform**. Registration is free and self-service through the Clerk's
online portal.

Three dates set the shape of the data:

| date | what happened |
| --- | --- |
| 2026-05-01 | the registration portal opened |
| 2026-07-30 | deadline for rentals already operating, B&Bs included, to register |
| 2026-07-31 | deadline for listings to display their number |

So a registration cohort was created almost entirely between May and July
2026, and renewals will fall in the same weeks each year. Change in this
source is bursty, not steady — see "How often it changes" below.

## Finding the endpoint

**This is unresolved and needs someone with a browser.** The Clerk's program
page links the registration portal, not a map or a dataset, and the ArcGIS
Feature Service the registry is published through is not linked from it. The
package therefore has no default URL: it reads `--service-url` or
`$ANCHORAGE_STR_REGISTRY_URL`. A wrong layer would scrape real,
plausible-looking rows of the wrong thing, which is worse than not running.

Where to look, in the order worth trying:

1. **The Municipality's open-data hub**, <https://data-muniorg.hub.arcgis.com/>
   (and the GIS landing page, <https://moa-muniorg.hub.arcgis.com/>). Search
   for "short term rental". On a dataset page, *I want to use this →
   View API Resources* gives the GeoService URL, which is the layer URL this
   package wants.
2. **The map gallery**, <https://muniorg.maps.arcgis.com/apps/MapAndAppGallery/index.html?appid=3f7e6c3a43ff4dab9e36f077a52418d0>.
   If a viewer app shows registrations, open its network tab and take the
   `.../FeatureServer/<n>` URL its queries go to.
3. **The organization's item search**, `https://muniorg.maps.arcgis.com/home/search.html?q=short%20term%20rental`.
4. **Ask.** The Clerk's office publishes the registry; the Geographic Data
   and Information Center runs the server. A public-records request is
   already the recommended route for addresses (see
   [`airbnb-address-deanonymization.md`](airbnb-address-deanonymization.md)),
   and the endpoint can ride along with it.

Confirm a candidate before wiring it in, which writes nothing:

```sh
node packages/registry/src/cli.ts probe 'https://…/FeatureServer/0'
```

It prints the layer's name, its record count, every field beside the column
`src/fields.ts` mapped it to, and a few records as they would be stored. If
the field names are not in `FIELD_ALIASES`, that output is the list to add
them from.

If the registry turns out not to be published as a Feature Service at all —
a CSV, a portal search page, a PDF — `packages/registry` still holds the
schema, the merge and the join views; only `src/arcgis/` and `src/extract.ts`
would be replaced.

## What a record holds

Not yet confirmed against the live layer. The columns
`packages/registry/src/fields.ts` looks for, and what each is worth:

| column | why it matters |
| --- | --- |
| registration number | the join key to `listings.str_registration_id` |
| status | a registration that exists is not necessarily in good standing |
| address, zip | **a street address for every registration** |
| parcel id | the join key to [anchorage-property](https://github.com/NickCrews/anchorage-property) |
| operator name | owner-operator vs. a name attached to many registrations |
| issued / expires | the compliance clock, and the renewal cohort |
| type | whole-home vs. owner-occupied, if the program distinguishes them |

The address column is the one to notice. The PRD defers street addresses for
listings as a public-records request; a matched registration supplies one
directly, for the subset of listings that show their number.

Registrations are issued through the Municipality's CityView permitting
system, so the layer may carry that system's own column names
(`FOLDERRSN`, `PERMITNUM`, `RECORDNUM`); `FIELD_ALIASES` lists them.

Whatever the columns turn out to be, nothing is lost by guessing wrong:
every record stores its complete `attributes` object as JSON, and the version
hash is computed over that rather than over the mapped columns.

## How often it changes

No measurement yet — the package records what is needed to make one. Every
run stores the layer's own `editingInfo.lastEditDate` in
`registry_runs.layer_last_edit` whether or not a record moved, so a few weeks
of runs answer "how often does the Municipality touch this?" directly, and
`records_changed` answers "how often does that change anything we store?".

What to expect, per registration:

| field | changes when | times per year |
| --- | --- | --- |
| registration number | never; it is the identity | 0 |
| address, parcel, coordinate | a correction | ~0 |
| type | a correction, or a change of use | ~0 |
| operator name | the property changes hands | a few % of records |
| status | issued, renewed, lapsed, revoked | 1-3 |
| expires date | renewal | 1 |

So a registration opens on the order of one to three new versions a year, and
most of them land in the weeks around the annual renewal, because the whole
registry was created in one three-month cohort in 2026. Expect long flat
stretches and an annual spike, not a steady trickle. The
`change_rate_plausible` check allows a quarter of the registry to change in
one run, which a renewal wave spread over weeks stays well inside; a run that
trips it is much more likely to be a republish that rewrote a column than a
real event.

Two mechanical changes are not registry changes at all, and the version hash
ignores both:

- **A rebuild.** Most municipal layers are refreshed by truncate-and-append,
  which rewrites `OBJECTID`, `GlobalID` and the edit stamps for every row at
  once. Hashing those would re-version the entire registry on such a day.
- **Float noise in the coordinate.** Rounded to 6dp, about 10cm.

## Reading the data

- **Esri dates are epoch milliseconds, UTC.** `fromEsriDate` takes the UTC
  calendar day. An issue date is a day, not an instant; whatever local
  midnight or noon the publisher wrote, the UTC day invents no timezone and
  is off by at most a day.
- **The layer is current state with no history.** Nothing in it says what a
  registration looked like last month, and there is no archive to backfill
  from. History starts when this package starts running, which is the same
  limitation the Airbnb side has.
- **A registration is not a listing.** One registration can cover several
  rooms, and a registered property may be advertised on Vrbo, booked direct,
  or not advertised at all. The join view keeps the match many-to-many rather
  than choosing.
