# Anchorage STR Database

Work in progress!

A daily record of Airbnb short-term rentals (STRs) in the Municipality of
Anchorage, Alaska, for answering questions like:

- How many listings are there, how many are active?
- What is the character of these rentals: number of bedrooms, price, run by an on-premise owner vs a host with many listings
- How has that changed over time? How does it vary between neighborhoods, price bands, size, listing type, etc?

## What you get

- One DuckDB file, `anchorage_str.duckdb`, with daily snapshots of listings
  and calendar availability, and of the Municipality's STR registrations
- Policy queries in `docs/policy_questions.sql`
- A browser viewer in `packages/ui/`, published at
  <https://nickcrews.github.io/anchorage-str-db/>

## Quick start

```sh
gh release download latest-data --repo NickCrews/anchorage-str-db -O anchorage_str.duckdb
duckdb anchorage_str.duckdb
```

```sql
SELECT count(*) FROM listings WHERE is_active;
```

## Running

Each upstream source has its own command, and in CI its own workflow and
schedule, so one source failing leaves the others updating. From the repo
root:

```sh
pnpm install
pnpm scrape airbnb
```

This searches the Anchorage bounding box, keeps the listings inside the
Municipality's boundary, fetches each listing's page and calendar, writes the
day to the database in one transaction, and runs the data-quality checks.

```sh
pnpm scrape licenses
```

This reads a batch of the Muni's CityView license pages, every license type,
into the same database. Each run picks up new license ids and re-reads the
ones that are due, then geocodes the licenses' new addresses with the Muni's
geocoder.

```sh
pnpm scrape parcels
```

This copies the current parcels from
[anchorage-property](https://github.com/NickCrews/anchorage-property)'s
published database into the same database, replacing the previous copy.

## Tables

Each table name starts with its source: `airbnb_`, `muni_str_` (the
Municipal Clerk's STR registration layer), `muni_license_` (the Muni's
CityView license pages), `muni_address_` (the Muni's geocoder), or
`property_` (anchorage-property's parcels). Views have no prefix.

- `airbnb_listing_observations`: one row per listing per scrape date, including
  whether its page was read (`page_fetch_ok`) and a price quote: Airbnb's
  price (`quote_total`) for a stay of `quote_nights` nights from
  `quote_check_in`, the listing's earliest bookable stay that day.
  `quote_label` is Airbnb's text (`$241 for 2 nights, originally $269`, or
  why there is no price) and `quote_breakdown` its price-detail lines, which
  show cents, discounts and fees. `quote_total` is the rounded displayed total.
- `airbnb_calendar_status`: nightly availability and minimum stay, stored
  change-only with `valid_from`/`valid_to`. The calendar has no prices.
- `airbnb_listing_first_reviews`: one row per listing whose reviews have been read,
  with the date of its oldest review (NULL if it had none). A listing with
  no row has not been read yet.
- `airbnb_listing_photos`: each listing's photo URLs, one row per distinct set, cover
  photo first. `listing_photos_current` *(view)* has each listing's latest
  set. Photos never open a listing version.
- `airbnb_scrape_runs`: one row per Airbnb scrape, with counts and errors
- `listings` *(view)*: one row per listing version, derived from the
  observations. `listings_active` filters to `is_active`. `host_id` is the
  primary host's Airbnb user id (`airbnb.com/users/show/<host_id>`), stable
  for the life of the host account; a change of host opens a new version.
  Co-hosts are not recorded. `first_available_date_est` is the earlier of
  `first_review_date` and `first_seen_date`: the listing existed on or before
  it. It is an estimate that can only be late: a listing with no reviews from
  before `first_seen_date` looks as new as the day it was first scraped.
  - `listing_type`: how much of a dwelling the listing covers, in Airbnb's text
    as written: `Entire home/apt`, `Private room`, `Shared room`,
    `Hotel room`. `property_title` (`Cabin in Palmer`) describes the
    building instead.
  - `guest_capacity` and `beds`: Airbnb's integers. A bunk bed counts as 2.
  - `bedrooms` and `bathrooms`: the listing page's text, as written:
    `2 bedrooms`, `Studio`; `1.5 baths`, `Shared bathroom`, `Half-bath`.
    Private and shared rooms usually have no bedroom line.
  - These, like `host_id`, come from the listing page: a change opens a new
    version, and a failed page fetch carries the previous value forward.
- `airbnb_host_observations`: one row per host per scrape date for every host with
  a listing observed that day: the public profile card from the listing page
  (display name, bio, `timeAsHost`), and whether it was read
  (`profile_read_ok`)
- `hosts` *(view)*: one row per host version, derived from
  `airbnb_host_observations` the way `listings` is derived from
  `airbnb_listing_observations`. A name or bio change opens a version; a failed read
  carries the last one forward. `hosting_started_on` is derived from
  `timeAsHost`, which Airbnb reports in whole months, so it can be up to a
  month late.
- `host_listing_portfolios` *(view)*: per host per scrape date, `listings_active` and
  `listings_ever_seen`: each host's Anchorage listing portfolio. Counts only
  listings inside the Municipality, so a host with 2 here and 40 elsewhere
  reads as 2 — their true portfolio is not in this database
  ([#34](https://github.com/NickCrews/anchorage-str-db/issues/34)). No threshold marking
  where a casual host ends and a commercial one begins is stored.
- `listings_active_with_host` *(view)*: `listings_active` plus the host's
  name, years hosting, and portfolio counts as of the latest run
- `calendar_current` *(view)*: the current version of each night. Use this
  instead of `airbnb_calendar_status` for "how many listings had calendar
  data that night, and how many of those were available"; it drops the frozen
  future nights of inactive listings

From the Municipal Clerk's
[Short Term Rental Registration Viewer](https://experience.arcgis.com/experience/22b40a78a9fc459e9950a16249b37ed2)
and the Muni's license portal, stored as published:

- `muni_str_registration_observations`: one row per registration per registry
  run, an archive: the layer answers only with a token, so nothing writes it.
  The Muni published only active registrations, so a registration missing
  from a run has lapsed or been withdrawn. `registered_address` is the address
  on the license: a Muni property record's address, or the registrant's typed
  text.
  `geocoded_address`, the coordinate, `community_council` and `parcel_type` are
  the Muni's derivations from it.
- `muni_license_page_reads`: each visible CityView license page read
  ([example](https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B)),
  of every license type, Short-Term Rentals re-read weekly and others
  monthly: the licensee's own
  `description` of the business ("Provides short term rentals, logistics,
  meeting space and overnight lodging."), `locations`, and every
  certificate `issuances` records, and the `submittals` the licensee filed.
  A location with a `link` comes from the Muni's property records (a parcel
  id, or that record's address); one without is text the registrant typed.
- `muni_license_hidden_reads`: one row per read of a hidden license id, whose
  page says "Invalid License"
- `muni_license_runs`: one row per license scan
- `muni_address_geocodes`: one row per license address sent to the Muni's
  geocoder: its `matched_address`, coordinate and `community_council`, all
  NULL when the geocoder could not place it, plus its best candidate's
  `score` and `match_type`
- `muni_str_registry_runs`: one row per registry run, an archive
- `property_parcels`: one row per parcel, copied whole from
  [anchorage-property](https://github.com/NickCrews/anchorage-property)'s
  current parcels by each parcel import: `parcel_address`, `property_type`
  (`RESIDENTIAL`, `CONDO`, ...), `total_living_units`, `land_use`,
  `zoning_district`, the parcel's centroid, and `valid_from`, when
  anchorage-property last saw it change. No history; that stays in
  anchorage-property.
- `property_parcel_imports`: one row per parcel import, with the
  anchorage-property ingest run it copied
- `licenses` *(view)*: one row per license with a visible page, of every
  type: its latest page read, `first_read_date`, `last_read_date`, and
  `is_active` (its most recent issuance is Active or Issued), its `address`
  and `parcel_id`, its parcel's `parcel__property_type` and
  `parcel__total_living_units` from `property_parcels`, and the geocoded coordinate and `community_council` of
  the address. An id whose latest read is hidden is left out.
- `registrations` *(view)*: one row per STR certificate number on a
  Short-Term Rentals license, plus the registrations only the archived layer
  holds. `is_active` means the certificate's status is Active.
  The geocoded coordinate and `community_council` are the license's own,
  else the archived layer's. `parcel_type` is the license's parcel's
  `property_type` in `property_parcels` (`RESIDENTIAL`, `CONDO`, ...), else
  the archived layer's `Residential`/`Commercial`; the two vocabularies
  differ. `submitted_date` comes from the archived layer alone. `airbnb_listings_active` counts the active Airbnb listings
  showing the id. `registrations_active` filters to `is_active`.
- `listings_active_with_registration` *(view)*: `listings_active` plus
  the registration matching `registration_id`: its address, parcel,
  business name and description. `registration_found` is false when the
  listing shows no id, or one not in the registry, which includes ids
  issued since the last license scan.
- `source_freshness` *(view)*: one row per upstream source (`airbnb`,
  `muni_licenses`, `property_parcels`) with the date and finish time of its
  latest successful run. Each source runs on its own schedule, so the dates
  differ.

## Known gaps

- **Prices are quotes for available stays, not a nightly series.** Airbnb
  prices a stay only while it can be booked, so nights that are not
  available — the ones revenue is made of — have no price. Each day's quote
  is the listing's earliest bookable stay. See
  [`docs/research/airbnb-calendar-price.md`](docs/research/airbnb-calendar-price.md).

- **Unregistered listings have no street address.** A listing showing a
  registration id gets the registered address and parcel from
  `listings_active_with_registration` (2047 of 2628 active listings on
  2026-09-13). For the rest, `location_exact_address` is null unless the
  host published one. Join on `location_lat`/`location_lng`, and filter on
  `location_is_exact` first: about half those coordinates are Airbnb's
  privacy jitter.

## Repo layout

A pnpm workspace sharing `tsconfig.base.json`:

- `packages/cli`: the one command line, `pnpm scrape <airbnb|licenses|parcels>`.
- `packages/airbnb-scraper`: the daily Airbnb run over `airbnb-client`: its
  writes and quality checks.
- `packages/licenses-scraper`: the license scan over `licenses-client` and
  `muni-gis-client`: which license pages to read, the writes and quality
  checks.
- `packages/parcels-scraper`: the parcel import from anchorage-property: its
  checks and the write.
- `packages/db`: the DuckDB schema, defined with Drizzle, its migrations and
  the views.
- `packages/airbnb-client`: fetches and parses Airbnb listings, in memory.
  Uses `impit`, an HTTP client that impersonates Chrome's TLS fingerprint,
  which Airbnb requires. The endpoints are in `src/api/`.
- `packages/licenses-client`: fetches and parses the Muni's license pages,
  in memory.
- `packages/muni-gis-client`: queries the Muni's ArcGIS services, in memory:
  its feature layers, the address geocoder and community councils.
- `packages/utils`: dependency-free helpers shared by the scrapers.
- `packages/ui`: the browser viewer.

See [CONTEXT.md](./CONTEXT.md) for the vocabulary these tables and docs use,
[CONTRIBUTING.md](./CONTRIBUTING.md) to run or change the pipeline, and the
[PRD](./docs/prd.md) for goals.
