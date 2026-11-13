# Data model: listings, registrations and hosts

The database joins two sources:

- **Airbnb** (`packages/scraper-airbnb`): listings and the hosts who run them.
- **The Municipality of Anchorage** (`packages/muni-licenses` and
  `packages/muni-gis`, read by `packages/ingest-muni-licenses`): every license's
  CityView license page, the Muni geocoder's reading of each license's
  address with its community council, each parcel's property type, and the
  archived STR registration layer the Municipal Clerk published.

The only link between them is the STR registration id a listing page shows
(`registration_id`, e.g. `STR20261754`). There is no shared address or owner
id.

The terms below are defined in [CONTEXT.md](../CONTEXT.md).

Counts below are marked with the date they were measured. They come from
`data/anchorage_str.duckdb` and change with every run; the relationships and
reasons do not.

## Entities

| Entity | Table | Identity | What it is |
| --- | --- | --- | --- |
| Listing | `listings_active` | Airbnb `listing_id` | One Airbnb page a guest can book. |
| Host | `hosts` | Airbnb `host_id` | The Airbnb account that runs the listing (`airbnb.com/users/show/<host_id>`). Often a property manager. |
| Registration | `registrations` | `registration_id` | One STR Certificate number on a Short-Term Rentals license page, with a registrant, address and dates. |
| License | `licenses` | `cityview_license_id` | One CityView license page of any type (Short-Term Rentals, Business, Alcohol), as last read, with its address geocoded and its parcel's type. |

`listings_active_with_registration` is every active listing with the
registration its id matches, if any.

A Short-Term Rentals license holds exactly one STR Certificate, whose
number is the `registration_id`, so a registration and its license are
one-to-one: on 2026-09-15 the layer held 2,564 registrations, 2,564
`cityview_license_id`s and 2,564 `license_id`s, none shared. `registrations`
carries the license's fields on the registration's own row for that reason,
and `licenses` adds the Business and Alcohol licenses, which hold no
registration. See [CONTEXT.md](../CONTEXT.md) for which id comes from where.

`registrations` is built from `licenses`, one row per STR Certificate
number:

- `status`, `issued_date`, `expires_date` and `is_active` come from the STR
  Certificate issuance; `is_active` means its status is `Active`.
- `business_name`, `registered_address` (the license's `address`: the
  page's Address location, else the first location that is not a parcel id)
  and the `license_*` columns come from the license's latest page read.
- `first_seen_date` and `last_seen_date` are the first and latest page reads
  that show the number.
- `geocoded_*` and `community_council` are the license's: the Muni
  geocoder's match for its address (`muni_address_geocodes`) and the
  council containing it. When the address has no match, or has not been
  geocoded yet, they come from the registration's latest row in the
  archived registration layer (`muni_str_registration_observations`), and
  are NULL for a registration the layer never held. The two sources are
  never mixed on one row.
- `parcel_type` is the `Property_Type` of the license's parcel
  (`muni_parcel_types`) when it names exactly one. The archived layer's
  `ParcelType` is a different classification and is not used.
- `submitted_date` comes from the archived layer alone.
- A registration only the archive holds, whose number no license in
  `licenses` shows, keeps its layer row with `is_active` false and NULL
  `license_*` columns.

`licenses` leaves out an id whose latest read found it hidden, so a
registration whose license page goes hidden drops out of `registrations`
unless the archive holds it.

`cityview_license_id` (`13923`) is the odd one out: it is CityView's own row
id for a license, the `licenseId` query parameter of the registration's
`status_url`. It keys `muni_license_page_reads` and `licenses` because it is
what fetches a page, and it means nothing outside the portal — never publish
it as an identifier of anything.

## Relationships

```
Host 1 ──── * Listing * ──── 0..1 Registration
```

### Listing → registration: many-to-one, optional on both sides

A listing page shows at most one id, so a listing matches zero or one
registration. A registration can be cited by any number of listings, or none.

Active registrations by how many active Airbnb listings cite them
(2026-09-14):

| Listings citing it | Registrations |
| --- | --- |
| 0 | 690 |
| 1 | 1,740 |
| 2–8 | 119 |

Active listings by match (2026-09-14, 2,619 listings):

| Status | Listings |
| --- | --- |
| Registered | 2,047 |
| No id shown | 554 |
| Id not in registry | 18 |

A registration cited by several listings can be:

- private rooms in one house, each listed separately: STR20261701, the Ski
  Inn, is cited by 8 private-room listings;
- dwellings in one building sharing an id: STR20261828, the 700 M St
  triplex, covers its three dwellings;
- a combo listing and the component listings it covers: at 700 M St the
  "Full 5BR Compound" and "3BR Combo" cite the same id as the dwellings they
  cover;
- duplicate listings, or an id reused on a dwelling it does not cover:
  STR20262388 is cited by listings from two hosts, one of them 45 km from
  the registered address.

The data cannot tell these apart.

A registration with no Airbnb listing may be listed on another platform, not
be operating, or be cited by a listing that shows no id.

"Id not in registry" includes ids issued since the license scan last read
new license ids, and ids on licenses whose page is hidden, so it is not
proof of an invalid id.

### Host → listing: one-to-many

Every listing has one primary host. On 2026-09-14, 1,286 hosts ran the 2,619
active listings; 369 hosts had 2 or more and 28 had 10 or more.

### Host ↔ registration: many-to-many, through listings

A host with many listings usually cites many ids, and an id can be cited by
listings from different hosts (15 ids on 2026-09-14), for example a co-host,
a change of manager, or a copied id.

Hosts differ in how their listings map to ids (2026-09-14):

| Host | Active listings | Distinct ids | Listings with no id | Registrants |
| --- | --- | --- | --- | --- |
| Casago Alaska Retreats | 64 | 50 | 4 | 49 |
| Casa Rentals | 53 | 51 | 1 | 33 |
| Evolve | 51 | 5 | 46 | 5 |

## Owners are not modeled

Neither source identifies the owner of a property.

- **Host** is the account the listing is run from. A property manager's
  listings cite registrations under dozens of different business names, so
  one host can stand for many owners.
- **Registration `business_name`** is text the registrant typed. It is closer
  to an owner, but it is not an identity: on 2026-09-14 the 2,549 active
  registrations had 1,675 distinct business names, 20 were blank and 17 read
  "Airbnb". The same business is spelled several ways ("3rd Avenue
  Investments", "3RD AVENUE INVESTMENTS ").
- **Licensee** is no better. `license_id` (`LC260500349`) belongs to the
  license, not the licensee, despite CityView labelling it "Licensee
  Number": all 312 business names on more than one registration have a
  separate one per registration (SWITZER SUITES has four). Grouping by it
  counts licenses, not operators.
- **Parcel id**, which would link to the assessor's owner of record, is set on
  457 of 2,549 active registrations (2026-09-14).

An owners table would need assessor records joined by parcel or address, or
name matching across business names. The UI groups by host instead.

## How the UI uses this

- **Listings**: one row per active listing, with its registration's status,
  address and parcel.
- **Hosts**: one row per host with active listings: listing count, distinct
  registration ids, listings per registration status, and the business
  names on the registrations its listings cite.
- **Registrations**: one row per registration. It is the only place a
  registration with no Airbnb listing appears, and it shows fields that
  belong to the registration alone: issue and expiry dates, license
  description, community council, and whether its STR Certificate is
  active.
