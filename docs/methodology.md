# Methodology

How the database is built: what each source contributes, how the sources
link a listing to an address, a parcel and an owner of record, how history
is kept, and what the data cannot tell you. The words used here are
defined in [CONTEXT.md](../CONTEXT.md); every table and column is in
[tables.md](tables.md).

Counts are marked with the run they come from. They change with every run;
the relationships do not.

## Sources

| Source | What it gives | How it is read | Tables |
| --- | --- | --- | --- |
| **Airbnb** | listings, their hosts, nightly availability, one price quote per listing | `pnpm scrape airbnb`, daily | `airbnb_*` |
| **The Muni's CityView license portal** | every business license, including each Short-Term Rentals license and its STR Certificate (the registration): registrant, address, parcel id, description, issuances | `pnpm scrape licenses`, daily | `muni_license_*` |
| **The Muni's geocoder** | a coordinate and community council for each license address | the license scrape's geocoding pass | `muni_address_geocodes` |
| **anchorage-property** | every Muni parcel's current record: property type, living units, land use, zoning, owner of record, mailing address, exemptions, appraised value | `pnpm scrape parcels`, daily | `property_*` |
| **The Clerk's registration layer** (archive) | registrations as the Municipal Clerk's ArcGIS layer published them, until it went private | nothing reads it now | `muni_str_*` |

**Airbnb.** Each run searches the Muni's bounding box, split into price
bands so no query paginates
([why](research/airbnb-search-pagination.md)), and keeps the listings whose
coordinate falls inside the Muni's boundary. It then reads every listing's
page (exact-location flag, registration id, host and host card, listing
type, guest, bed, bedroom and bathroom counts, photos), its twelve-month
calendar, the price of its earliest bookable stay, and, once per listing, the
date of its oldest review.

**Licenses.** CityView numbers every license of every type from one
counter, and most ids are hidden. The license scrape reads new ids each
run, re-reads Short-Term Rentals licenses weekly and others monthly
([order](../packages/licenses-scraper/README.md)). A Short-Term Rentals
license holds exactly one STR Certificate, whose number is the
`registration_id`, so a registration and its license are one record
(see "Three ids, one license" in [CONTEXT.md](../CONTEXT.md)). The page
carries the license's address, either a Muni property record's address or
text the registrant typed, and a parcel id when the registrant picked a
property record.

**Parcels.** [anchorage-property](https://github.com/NickCrews/anchorage-property)
reads the Muni's parcel layer daily and keeps every parcel's history. This
repo copies only its current parcels (about 98,500) into `property_parcels`
and replaces the table each scrape.

**The archived registration layer** answered anonymous requests until
October 2026 ([research](research/muni-str-registry-source.md)). Its rows are
kept. `registrations` takes `submitted_date` from it, falls back to its
geocoding and parcel type when the license has none, and keeps the
registrations only it holds, as not active.

## How a listing gets an address, a parcel and an owner

The sources share no key except the registration id a host prints on the
listing page:

```
Host 1 ── * Listing * ── 0..1 Registration 1 ── 1 License * ── 0..1 Parcel
                 registration_id                     parcel_id
```

1. **Listing → registration**, on `registration_id`. The host types the id;
   it is the only link between Airbnb and the Muni.
2. **Registration → license** is one-to-one: they are the same record.
   The license supplies the registered address, its geocoded coordinate and
   community council, the registrant's business name and description.
3. **License → parcel**, on `parcel_id`, when the license page names exactly
   one property record.
4. **Parcel → owner of record**: `property_parcels.owner_name` and the
   owner's mailing address, with the parcel's property type, living units
   and exemptions.

`listings_active_with_registration` does steps 1–3; join its
`registration_parcel_id` to `property_parcels.parcel_id` for step 4.

Active listings by how far the chain reaches (Airbnb run of 2026-11-16,
license scrape of 2026-11-25):

| Listing | Listings | Exact coordinate | What it gets |
| --- | --- | --- | --- |
| Registered, license names one parcel | 1,975 | 666 | address, community council, parcel, owner of record |
| Registered, license names no single parcel | 143 | 58 | address, community council |
| Shows an id not in the registry | 8 | 3 | Airbnb's coordinate only |
| Shows no id | 144 | 93 | Airbnb's coordinate only |
| **Total** | **2,270** | **820** | |

So 93% of active listings have a street address and 87% an owner of record.
For the other 152, the coordinate is all there is. Where it is exact, a
nearest-parcel match is usually right
([`policy_questions.sql`](policy_questions.sql) has one); where it is
jittered (about two thirds of listings), Airbnb has moved it, typically by
150–200 m, and no technique available to us recovers the address
([research](research/airbnb-address-deanonymization.md),
[an attempt](research/apify-addresses/README.md)).

An "id not in the registry" may be a typo, an id on a license whose page is
hidden, or one issued since the license scrape last read new ids, so it is
not proof the listing is unregistered.

### The id is a claim

A registration id on a listing is what the host typed, not a verified
match. The address, parcel and owner it brings belong to the registration,
and are the listing's only if the host cited the right id. On 2026-09-14, 30
listings cited an id registered 1 km to 45 km away
([research](research/registration-location-mismatch/README.md)). Inference
rules for a missing or wrong id are researched in
[registration-inference](research/registration-inference/README.md) and not
applied.

### Cardinalities

**Listing → registration: many-to-one, optional on both sides.** A listing
shows at most one id. A registration can be cited by any number of
listings. Active registrations by the active listings citing them
(2026-11-16 / 2026-11-25):

| Listings citing it | Registrations |
| --- | --- |
| 0 | 885 |
| 1 | 1,784 |
| 2–18 | 125 |

A registration cited by several listings can be private rooms in one house
(STR20261701, the Ski Inn, 8 listings), several dwellings under one id
(STR20261828, the 700 M St triplex), a combo listing and the component
listings it covers, or an id reused on a dwelling it does not cover. The data
does not tell these apart. A registration with no Airbnb listing may be
listed on another platform, cited by a listing that shows no id, or not
operating.

**What a registration covers has no fixed grain.** One registration may
cover many rooms or many dwellings, and one dwelling may hold several
registrations; see "What a registration covers" in
[CONTEXT.md](../CONTEXT.md).

**License → parcel: many-to-one, optional.** Several licenses can name one
parcel (a building with a registration per dwelling). A license whose page
names no parcel, or several, gets none.

**Host → listing: one-to-many.** Every listing has one primary host. On
2026-11-16, 1,120 hosts ran the 2,270 active listings; 331 had 2 or more and
22 had 10 or more. Co-hosts are not recorded.

**Host ↔ registration: many-to-many, through listings.** A host with many
listings cites many ids, and 17 ids were cited by listings from more than one
host on 2026-11-16 (a co-host, a change of manager, or a copied id).

## Host, registrant, owner of record

Three different parties, and none is an identity across sources:

- **Host**: the Airbnb account the listing runs from, often a property
  manager. Casago Alaska Retreats' 57 active listings cite 48 registrations
  under 47 business names (2026-11-16).
- **Registrant**: the `business_name` on the registration, typed by the
  registrant. 2,794 active registrations carry 1,791 distinct names, 27
  blank (2026-11-25), and one business is spelled several ways.
  `license_id` names the license, not the licensee, so grouping by it counts
  licenses, not operators.
- **Owner of record**: `property_parcels.owner_name`, as the Muni's parcel
  records give it. Text, with no owner id: grouping by it approximates an
  owner dwelling portfolio, and only for the registered listings whose
  license names a parcel. The mailing address is where tax notices go, not
  necessarily where the owner lives; `exemption_types_all` containing
  `OWNERS PRIMARY RESIDENCE` is the owner's claim to live there (801 active
  registrations' parcels, 2026-11-25).

## How history is kept

Every source's run appends rows stamped with its `scrape_date` and never
updates them; the views derive everything else. A bug in a derivation is
fixed by editing a view, and the published file is the only copy of the
archive. A run writes a whole day or nothing.

- **Listings and hosts** are versioned: `listings` and `hosts` have one row
  per run of unchanged attributes (`valid_from`/`valid_to`). A listing is
  active while it has been seen within five days of the latest completed
  Airbnb run, since search occasionally omits a listing for a day. A failed
  page read carries the previous values forward.
- **The calendar** is stored change-only. `calendar_current` is each
  night's latest value, without the frozen future nights of listings that
  went inactive.
- **Registrations** are current as of each license's latest page read; a
  registration is active when its STR Certificate's status is `Active`.
- **Parcels** are the current snapshot only. A listing from September
  joined to `property_parcels` gets today's owner of record; ask
  anchorage-property for a parcel's history.
- **Freshness**: each source has its own schedule and can fail on its own.
  `source_freshness` gives each one's latest successful run.

Nothing is backfilled. History starts with the first scrape in the file.

## What the database leaves to analysis

The database records what the sources publish and nothing more: no
estimates, classifications or thresholds. The viewer
([`packages/ui`](../packages/ui/README.md)) does the interpreting in the
browser, from the published tables:

- **Occupancy and revenue.** A night is available or not available; the
  calendar does not say whether a not-available night was booked or blocked
  by the host. The viewer classifies runs of closed nights and prices them
  from the quotes, with low, middle and high models
  (`packages/ui/src/model/estimates.ts`).
- **Owner kind and residence**: company, trust or person from the owner
  name, and whether the mailing address is in the Muni.
- **Where a casual host ends and a commercial one begins.**

## Limitations

- **Airbnb only.** Vrbo and direct bookings are not scraped. A registration
  with no Airbnb listing is not evidence it is not operating.
- **Not available is not booked.** See above. Any occupancy figure is an
  estimate with a range.
- **Prices are quotes for available stays.** Airbnb prices a stay only while
  it can be booked, so the nights that make revenue have no price. Each day
  records the price of one listing's earliest bookable stay
  ([research](research/airbnb-calendar-price.md)).
- **About two thirds of coordinates are jittered.** Filter
  `location_is_exact` before any spatial join.
- **Unregistered listings have no address** (152 of 2,270 above), and a
  registered listing's address is only as good as the id the host typed.
- **No dwelling counts.** Listings and registrations are both many-to-many
  with dwellings, and nothing yet marks combo listings
  ([#38](https://github.com/NickCrews/anchorage-str-db/issues/38)) or builds a
  dwelling table ([#40](https://github.com/NickCrews/anchorage-str-db/issues/40);
  [design](research/rental-units/README.md)). Count listings or
  registrations, and say which.
- **Host portfolios count Anchorage only.** A host with 2 listings here and
  40 elsewhere reads as 2
  ([#34](https://github.com/NickCrews/anchorage-str-db/issues/34)).
- **Relisting is not detected.** A host who deletes a listing and relists it
  gets a new `listing_id`.
- **`first_available_date_est` can only be late.** It is the earlier of the
  first review and the first day we saw the listing.
- **Two parcel-type vocabularies.** `registrations.parcel_type` is
  anchorage-property's `property_type` (`RESIDENTIAL`, `CONDO`, ...) where the
  parcel is known, else the archived layer's `Residential`/`Commercial`.
  Compare values within one.
- **The schema is not stable yet.**
