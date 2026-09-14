# Data model: listings, registrations and hosts

The database joins two sources:

- **Airbnb** (`packages/scraper-airbnb`): listings and the hosts who run them.
- **The Municipality of Anchorage** (`packages/scraper-muni-str`,
  `packages/muni-licenses`): the STR registrations the Municipal Clerk
  publishes, and each registration's CityView license page.

The only link between them is the STR registration number a listing page
shows (`str_registration_id`, e.g. `STR20261754`). There is no shared address
or owner id.

Counts below are marked with the date they were measured. They come from
`data/anchorage_str.duckdb` and change with every run; the relationships and
reasons do not.

## Entities

| Entity | Table | Identity | What it is |
| --- | --- | --- | --- |
| Listing | `listings_current` | Airbnb `listing_id` | One Airbnb page a guest can book. |
| Host | `hosts` | Airbnb `host_id` | The Airbnb account that runs the listing (`airbnb.com/users/show/<host_id>`). Often a property manager. |
| Registration | `registrations` | `registration_number` | One STR registration in the Muni's published layer, with a business name, address and dates. |

`listings_current_with_registration` is every current listing with the
registration its number matches, if any.

## Relationships

```
Host 1 ──── * Listing * ──── 0..1 Registration
```

### Listing → registration: many-to-one, optional on both sides

A listing page shows at most one number, so a listing matches zero or one
registration. A registration can be cited by any number of listings, or none.

Current registrations by how many current Airbnb listings cite them
(2026-09-14):

| Listings citing it | Registrations |
| --- | --- |
| 0 | 690 |
| 1 | 1,740 |
| 2–8 | 119 |

Current listings by match (2026-09-14, 2,619 listings):

| Status | Listings |
| --- | --- |
| Registered | 2,047 |
| No number shown | 554 |
| Number not in registry | 18 |

A registration cited by several listings can be:

- private rooms in one house, each listed separately;
- units in one building sharing a number;
- duplicate listings, or a number reused on a unit it does not cover.

The data cannot tell these apart.

A registration with no Airbnb listing may list on another platform, not be
operating, or be cited by a listing that shows no number.

"Number not in registry" includes numbers issued since the Muni last
published its layer, so it is not proof of an invalid number.

### Host → listing: one-to-many

Every listing has one primary host. On 2026-09-14, 1,286 hosts ran the 2,619
current listings; 369 hosts had 2 or more and 28 had 10 or more.

### Host ↔ registration: many-to-many, through listings

A host with many listings usually cites many numbers, and a number can be
cited by listings from different hosts (15 numbers on 2026-09-14), for
example a co-host, a change of manager, or a copied number.

Hosts differ in how their listings map to numbers (2026-09-14):

| Host | Current listings | Distinct numbers | Listings with no number | Registered business names |
| --- | --- | --- | --- | --- |
| Casago Alaska Retreats | 64 | 50 | 4 | 49 |
| Casa Rentals | 53 | 51 | 1 | 33 |
| Evolve | 51 | 5 | 46 | 5 |

## Owners are not modeled

Neither source identifies the owner of a property.

- **Host** is the operator account. A property manager's listings cite
  registrations under dozens of different business names, so one host can
  stand for many owners.
- **Registration `business_name`** is text the applicant typed. It is closer
  to an owner, but it is not an identity: on 2026-09-14 the 2,549 current
  registrations had 1,675 distinct business names, 20 were blank and 17 read
  "Airbnb". The same business is spelled several ways ("3rd Avenue
  Investments", "3RD AVENUE INVESTMENTS ").
- **Parcel id**, which would link to the assessor's owner of record, is set on
  457 of 2,549 current registrations (2026-09-14).

An owners table would need assessor records joined by parcel or address, or
name matching across business names. The UI groups by host instead.

## How the UI uses this

- **Listings**: one row per current listing, with its registration's status,
  address and parcel.
- **Hosts**: one row per host with current listings: listing count, distinct
  registration numbers, listings per registration status, and the business
  names on the registrations its listings cite.
- **Registrations**: one row per registration. It is the only place a
  registration with no Airbnb listing appears, and it shows fields that
  belong to the registration alone: issue and expiry dates, license
  description, community council, and whether the Muni still publishes it.
