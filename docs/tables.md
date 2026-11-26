# Tables and views

Each table name starts with its source: `airbnb_`, `muni_str_` (the
Municipal Clerk's STR registration layer), `muni_license_` (the Muni's
CityView license pages), `muni_address_` (the Muni's geocoder), or
`property_` (anchorage-property's parcels). Views have no prefix.

For how the sources fit together, see [methodology.md](methodology.md).

## From Airbnb

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
- `airbnb_listing_photos`: each listing's photo URLs, cover photo first, one row
  each time the photos or the cover photo change. Reordering the other photos
  writes no row. `listing_photos_current` *(view)* has each listing's latest
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

## From the Muni

The Muni's CityView license portal, the Muni's geocoder, and the archived
registration layer the Municipal Clerk published in the
[Short Term Rental Registration Viewer](https://experience.arcgis.com/experience/22b40a78a9fc459e9950a16249b37ed2),
stored as published:

- `muni_license_page_reads`: each visible CityView license page read
  ([example](https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B)),
  of every license type, Short-Term Rentals re-read weekly and others
  monthly: the licensee's own
  `description` of the business ("Provides short term rentals, logistics,
  meeting space and overnight lodging."), `locations`, and every
  certificate `issuances` records, and the `submittals` the licensee filed.
  A location with a `link` comes from the Muni's property records (a parcel
  id, or that record's address); one without is text the registrant typed.
  Keyed by `cityview_license_id`, CityView's internal row id, which fetches
  the page and means nothing outside the portal.
- `muni_license_hidden_reads`: one row per read of a hidden license id, whose
  page says "Invalid License"
- `muni_license_scrape_runs`: one row per license scrape
- `muni_address_geocodes`: one row per license address sent to the Muni's
  geocoder: its `matched_address`, coordinate and `community_council`, all
  NULL when the geocoder could not place it, plus its best candidate's
  `score` and `match_type`
- `muni_str_registration_observations`: one row per registration per registry
  run, an archive: the layer answers only with a token, so nothing writes it.
  The Muni published only active registrations, so a registration missing
  from a run had lapsed or been withdrawn. `registered_address` is the address
  on the license: a Muni property record's address, or the registrant's typed
  text. `geocoded_address`, the coordinate, `community_council` and
  `parcel_type` are the Muni's derivations from it. `BusinessName` was the
  string `'None'` when none was given, and an address the geocoder could not
  match has `geocoded_address` `'Incomplete address provided. No Match.'`
  and a placeholder coordinate; both are stored as published and cleaned in
  `registrations`.
- `muni_str_registry_runs`: one row per registry run, an archive
- `licenses` *(view)*: one row per license with a visible page, of every
  type: its latest page read, `first_read_date`, `last_read_date`, and
  `is_active` (its most recent issuance is Active or Issued). `address` is
  the page's Address location (a property record's address), else the first
  location that is not a parcel id, usually the licensee's typed text.
  `parcel_id` is set when the page names exactly one parcel, and
  `parcel__property_type` and `parcel__total_living_units` are that
  parcel's in `property_parcels`. The geocoded coordinate and
  `community_council` are the geocoder's match for `address`, NULL when it
  has none or has not been asked yet. An id whose latest read is hidden is
  left out.
- `registrations` *(view)*: one row per STR Certificate number on a
  Short-Term Rentals license in `licenses`, plus the registrations only the
  archived layer holds.
  - `status`, `issued_date`, `expires_date` and `is_active` come from the
    STR Certificate issuance; `is_active` means its status is `Active`.
    `registrations_active` filters to it.
  - `business_name` (NULL for the layer's `'None'`), `registered_address`
    (the license's `address`), `parcel_id` and the `license_*` columns come
    from the license's latest page read. `first_seen_date` and
    `last_seen_date` are the first and latest page reads showing the number.
  - The geocoded coordinate and `community_council` are the license's own
    when the geocoder matched its address, else the archived layer's; one
    row never mixes the two. They are NULL where the layer's geocoder found
    no match.
  - `parcel_type` is the license's parcel's `property_type` in
    `property_parcels` (`RESIDENTIAL`, `CONDO`, `APARTMENT`, ...), else the
    archived layer's `Residential`/`Commercial`; the two vocabularies
    differ.
  - `submitted_date` comes from the archived layer alone.
  - `airbnb_listings_active` counts the active Airbnb listings showing the
    id.
  - A registration only the archive holds keeps its layer row, with
    `is_active` false and NULL `license_*` columns. A registration whose
    license page goes hidden drops out unless the archive holds it.

## From anchorage-property

- `property_parcels`: one row per parcel, copied whole from
  [anchorage-property](https://github.com/NickCrews/anchorage-property)'s
  current parcels by each parcel scrape: `parcel_address`, `property_type`
  (`RESIDENTIAL`, `CONDO`, ...), `total_living_units`, `land_use`,
  `zoning_district`, the parcel's centroid, `valid_from`, when
  anchorage-property last saw it change, the owner of record and mailing
  address (`owner_name`, `owner_address`, `owner_city`, `owner_state`,
  `owner_zip`), `exemption_types_all` (`OWNERS PRIMARY RESIDENCE`, ...) and
  `appraised_total_value`. No history; that stays in anchorage-property.
  Join on `parcel_id` from `licenses`, `registrations` or
  `listings_active_with_registration.registration_parcel_id`.
- `property_parcel_scrape_runs`: one row per parcel scrape, with the
  anchorage-property ingest run it copied

## Across sources

- `listings_active_with_registration` *(view)*: `listings_active` plus
  the registration matching `registration_id`, as `registration_*`
  columns: active or not, business name, address, parcel id and type,
  community council, issue and expiry dates, the license description, and
  how many active listings cite it. `registration_found` is false when the
  listing shows no id, or one not in the registry, which includes ids
  issued since the last license scrape. See
  [methodology.md](methodology.md#how-a-listing-gets-an-address-a-parcel-and-an-owner).
- `source_freshness` *(view)*: one row per upstream source (`airbnb`,
  `muni_licenses`, `property_parcels`) with the date and finish time of its
  latest successful run. Each source runs on its own schedule, so the dates
  differ.
