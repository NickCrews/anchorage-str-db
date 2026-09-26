# Anchorage STR

A daily record of short-term rentals in the Municipality of Anchorage, built
from two independent sources — Airbnb's public pages and the Municipality's
STR registry — that share no key but the registration id a listing prints on
its page.

This file is the vocabulary the whole repo uses: table and column names, code
identifiers, comments, docs and UI copy. When a word here has an `_Avoid_`
list, the alternatives are not synonyms to reach for on a second mention —
they are wrong. Adding a concept means adding it here first.

One exception: a source's own label, quoted as the source writes it, stays
verbatim — the ArcGIS field `RegistrationNumber`, the license page's
"Licensee Number", the ordinance's "STR Registration Number", Airbnb's
`Entire home/apt`. Name our column for the concept; quote theirs for the
field.

## Language

### What is rented

**Unit**:
A physical space rented as a whole — a house, an apartment, a cabin, a
bedroom in an occupied home. What it is used for is a separate question: a
unit may be a short-term rental, a long-term rental, or owner-occupied. Every
STR is a unit; most units are not STRs, and nothing here sees the ones that
are not. The cross-source concept: a unit may have listings on several
platforms, a registration, both, or neither. No table holds units; see
[rental-units](./docs/research/rental-units/README.md) for why grouping
records into them is unsolved.
_Avoid_: property, rental, dwelling, room, STR, home

**STR**:
Short-term rental: a unit rented out for stays shorter than 30 days, which is
what the Muni requires a registration for. As with units above, this database
cannot give an accurate picture of these; estimate from listings and
registrations, which are what it holds. An adjective, not a countable thing:
an "STR registration", never "2,600 STRs".
_Avoid_: using it to mean a listing or a unit

**Listing**:
One Airbnb page a guest can book, identified by `listing_id`. Neither
direction is one-to-one, and both counterexamples are in the data rather than
hypothetical: one unit can carry several listings on one platform — 4011
Turnagain Blvd E Unit 4A is listed twice, by a property manager and by the
owner, from two host accounts — and one listing can cover several units —
STR20261828's triplex is listed whole as well as by unit, and booking the
whole makes the others unavailable. See
[rental-units](./docs/research/rental-units/README.md) §1 and §3.
_Avoid_: room, rental, ad, property, STR, unit

**Building type**:
What kind of building Airbnb says a listing is in, `building_type`: Airbnb's
`propertyTypeName` on a host's profile, stored verbatim (`Chalet`, `Hotel`,
`Cabin`). Only listings read from host profiles have one. Not a listing
type, which is how much of the unit a listing covers.
_Avoid_: property type, home type

**Listing type**:
How much of a unit a listing covers, `listing_type`. The values are Airbnb's
display text, stored verbatim: `Entire home/apt`, `Private room`, `Shared
room`, `Hotel room`. Airbnb's own key is `roomType`, which is why the parser
reads that word and nothing else does — the concept belongs to the listing,
and it is Airbnb's alone. A unit-level equivalent would need its own values,
since housing policy has no use for hotel rooms or single rooms.
_Avoid_: room type, property type, rental type

**Night**:
One date on a listing's calendar, `night_date`. The grain of
`airbnb_calendar_status`.
_Avoid_: day, date

**Stay**:
Consecutive nights booked together. Airbnb prices a stay (e.g. "$450 for 3
nights"), not per night, so the price data is a **quote**: `quote_total` for
`quote_nights` nights from `quote_check_in`.
_Avoid_: booking, reservation, trip

### Who is involved

**Host**:
The Airbnb account a listing is run from, identified by `host_id` and stable
for the life of the account. The operator: often a property manager or rental
company listing for many owners, so a host is not necessarily an owner,
though they may be the same person. Co-hosts are not recorded.
_Avoid_: operator, owner, property manager, landlord, account, user

**Owner**:
The legal owner of a unit. Not in this database — neither source publishes
it. Say so rather than substituting host or registrant.
_Avoid_: using it for host or registrant

**Registrant**:
The entity named on a registration, as `business_name`. Typed text, not an
identity: the same business is spelled several ways, and it is blank or
`Airbnb` on some registrations.
_Avoid_: applicant, owner, host, business

**Licensee**:
The entity a license is issued to, named on the license page as
`business_name`. Like the owner, the licensee is a name in this data, not an
identity.
_Avoid_: applicant, registrant, business, license holder

**Portfolio**:
What one party holds. Both halves are ambiguous on their own, so name them
unless the sentence has already fixed both: whose it is (**host** or
**owner**) and what is counted (**listings** or **units**). A host listing
portfolio and an owner unit portfolio are different measurements, and this
database can only compute the first.

A portfolio is everything the party holds, wherever it is. A host running
forty units from Palmer has a portfolio of forty, and that is the number an
operator question wants. No threshold separating a hobbyist from a commercial
operator is stored — that line is drawn downstream.

`host_listing_portfolios.listings` is the host listing portfolio: every
listing on the host's Airbnb profile, read once a run, wherever the listings
are. "Listings per host" means this number. How many of them are in the
Muni (`listings_in_muni`) is not a portfolio; it weights a host by the
listings they run here.
_Avoid_: empire, holdings, inventory, tycoon

### The Municipality

**The Muni**:
The Municipality of Anchorage. "The Municipal Clerk" specifically for the
office that publishes the registration layer. Its boundary is the scope of
this database: the daily run searches a padded bounding box that also takes
in Hope, Palmer and Wasilla, and drops every listing whose coordinate falls
outside the boundary itself, so every count here is a count inside the Muni.
_Avoid_: the city, Anchorage, MOA, the municipality

**Registration**:
One STR certificate the Municipal Clerk publishes, identified by
`registration_id`. Required to operate a short-term rental; a listing prints
its id on the listing page, which is the only link between the two sources.
_Avoid_: permit, certificate, license, registration number, STR number

**What a registration covers** has no fixed grain, so do not treat any tuple
— (registrant, address), (registrant, address, listing type), or another — as
its key. The registrant decides what to file, and both directions occur:

- One registration, many units: STR20261701 (189 Hightower Rd, Girdwood)
  covers 8 private-room listings.
- Many registrations, one unit and one registrant: 7901 Highlander Dr holds
  four registrations under Nordic Lodgings LLC, all with the same address
  string, and 400 Turpin St Unit 8 holds one per bedroom.

On 2026-09-15, 115 (registrant, address) pairs held more than one of the
2,564 active registrations, covering 293 of them.
`packages/scraper/test/registrationGrain.test.ts` asserts this against the
live layer, so a Muni change to the rule fails a test rather than quietly
invalidating a join.

**License**:
The Muni business license a registration is issued under, read from its
CityView page. It carries what the registration layer lacks: the licensee's
own description of the business, parcel ids, and every certificate issued.
One license holds exactly one STR Certificate, so a license and a
registration are the same thing seen from two systems — see **Three ids, one
license** below.
_Avoid_: registration, permit, licence

**Parcel**:
A Muni property record, identified by `parcel_id`. The join key to
[anchorage-property](https://github.com/NickCrews/anchorage-property).
_Avoid_: lot, property, tax record

**Community council**:
The Muni's neighborhood district, derived by the Muni from a registration's
coordinate. Only registrations have one.
_Avoid_: neighborhood, district, area

### Identifiers

**`_id`, not `_number`**:
Every identifier here is alphanumeric (`STR20260309`, `LC260500349`) or an
opaque integer, so it is an id. Reserve `_number` for something countable.
_Avoid_: `registration_number`, `application_number`, `licensee_number`

**Three ids, one license**:
A registration, the license it was issued under, and that license's CityView
page are one record under three numbering systems. Echo Ridge Mountain
Retreat, read 2026-09-15:

| Id | Value | Where it comes from | Who sees it |
| --- | --- | --- | --- |
| `registration_id` | `STR20260309` | the STR Certificate issued under the license | printed on the Airbnb listing — the only one the public sees |
| `license_id` | `LC260500349` | the license page's "Licensee Number", and the layer's `ApplicationNumber` | anyone opening the license page |
| `cityview_license_id` | `13923` | the `licenseId` in that page's URL | nobody — CityView's internal row id |

The three are one-to-one-to-one. That is about the three numbering systems
and nothing else: it says these ids name one record, not that the record
names one unit, one listing or one registrant. What a registration covers is
the question above, and the answer there is that it has no fixed grain.
On 2026-09-15 the layer held 2,564
registrations, 2,564 distinct `license_id`s and 2,564 distinct
`cityview_license_id`s, with no value of any one shared across two of
another, so joining on any of them is equivalent.
`packages/scraper/test/identifiers.test.ts` asserts this against both live
sources, and fails rather than drifts if the Muni changes how it issues them.

**The `LC` id names the license, not the licensee**:
Which is why it is `license_id` and not `licensee_id`, despite the portal
labelling it "Licensee Number". Every one of the 312 business names holding
more than one registration holds a separate one for each: SWITZER SUITES has
STR20260008-11 under LC260500044-47 and CityView ids 13615-18 — four
licenses, not one licensee with four registrations. Never group by it to
count operators.

**`registration_id`**:
`STR20260309`. On a registration it is the Clerk's; on a listing it is what
the listing page prints, which may match no registration.

### Where a thing is

**Coordinate**:
A `lat`/`lng` pair. A listing's is Airbnb's (`location_lat`/`location_lng`);
a registration's is the Muni geocoder's (`geocoded_lat`/`geocoded_lng`).
ArcGIS's own "point layer" stays verbatim, as a source's label does.
_Avoid_: point, location, position, pin, geo

**Address**:
A street address as text. A listing has one only when the host published it
(`location_exact_address`); a registration's is `registered_address`, either
a property record's or the registrant's typed text.
_Avoid_: location, street, place

**Exact and jittered**:
The two states of a listing's coordinate, and opposites. **Exact** is
Airbnb's real position; **jittered** is the privacy offset Airbnb publishes
instead, stable per listing so repeat scraping does not average it out. About
half are jittered, so filter `location_is_exact` before any spatial join.
_Avoid_: for exact — precise, real, verified, unjittered; for jittered —
fuzzed, blurred, approximate, obfuscated

**Geocoded**:
Of a registration: derived by the Muni from `registered_address` rather than
given by the registrant — its coordinate, `geocoded_address`,
`community_council` and `parcel_type`.

### Lifecycle

**Operating**:
Of a unit: being rented as an STR. A fact about the world, not about this
data — a unit operating without a registration or a listing is invisible
here, and the closest this database gets to the word is an active listing.
_Avoid_: active, running, in business, live

**Active**:
Of a listing: still appearing in search, within `RETIREMENT_GRACE_DAYS` of
the latest completed run (`is_active`, `listings_active`). Of a registration:
in the latest registry run's layer, which holds only active registrations.
The word for "still out there" in schema and UI alike, at the grain of one
record: a listing was active from June 2025, a unit is operating. Licenses
are valid or expired instead; neither is a synonym for this.
_Avoid_: current, live, operating, open, in service

**Inactive**:
Of a listing: no longer active. The Muni equivalent is lapsed. **Retire** is
the transition into it, five days (`RETIREMENT_GRACE_DAYS`) after the last
run that saw the listing; `airbnb_scrape_runs.listings_retired` counts the
listings that went inactive on that run.
_Avoid_: dead, gone, removed, delisted, expired

**Lapsed**:
Of a registration: no longer published by the Clerk, so its term ended, it
was withdrawn, or the Muni stopped publishing it. The Airbnb equivalent is
inactive. Not the same as expired, which is about the license term rather
than about publication.
_Avoid_: departed, gone, expired, dropped, retired

**Valid**:
Of a license: today is on or before its `expires_date`. A date test, not a
status — every STR license expires 2027-04-30 whatever month it was issued
in, so a license issued in August is valid for nine months and one issued in
May for twelve. The page's own `Active` text is the Muni's word, stored
verbatim in `license_status`, and is not this one.
_Avoid_: active, current, live, in force, good standing

**Expired**:
Of a license: past its `expires_date`. Says nothing about whether the
registration still appears in the layer: expired is about the term, lapsed
about publication, and a registration can be either without the other until
a renewal is observed.
_Avoid_: lapsed, inactive, retired, dead, invalid

**Version**:
One run of unchanged attributes on a listing or host, `valid_from` to
`valid_to`. Which attributes open a version is `VERSION_KEY_SQL`.
_Avoid_: revision, snapshot, record, change

**Current version**:
The latest version of a record — `valid_to IS NULL`, or
`airbnb_calendar_status.is_current`. Bookkeeping about a row, never a
statement about the listing: an inactive listing still has a current version.
_Avoid_: active, latest, newest

**Observation**:
One row recording what a source said about one entity on one run, in an
`*_observations` table. Append-only and never updated; everything else is
derived from them in views.
_Avoid_: snapshot, record, reading, sample, event

**Run**:
One execution of a pipeline, stamped with `scrape_date` and logged in a
`*_runs` table. The **daily run** (`pnpm daily`) reads Airbnb; the
**registry run** (`pnpm registry`) reads the Muni. A run records a whole day
or nothing.
_Avoid_: job, scrape, crawl, batch, pass (a pass is one stage within a run)

**Seen**:
Of a listing or registration: present in a run's results (`first_seen_date`,
`last_seen_date`). Distinct from read.
_Avoid_: found, observed, present

**Read**:
Of a page fetched one at a time — a listing page, host card or license page —
that parsed successfully (`page_fetch_ok`, `profile_read_ok`). A failed read
carries the previous value forward rather than blanking it.
_Avoid_: fetched, scraped, loaded, got

### Availability

**The states of a night**:
For one (listing, night) row, Airbnb publishes one bit, `available`, so there
are two observed states and no third:

| State | Meaning | Observable |
| --- | --- | --- |
| **Available** | bookable on the calendar we read | yes, `available` |
| **Not available** | not bookable | yes, `NOT available` |
| **Booked** | not available because a guest took it | no — an interpretation |
| **Blocked** | not available because the host closed it off | no — an interpretation |

Available and not available are exhaustive and mutually exclusive. Booked and
blocked split "not available" and the calendar cannot tell them apart, so
never report either as a count: say "not available", and caveat any occupancy
figure derived from it.
_Avoid_: for available — open, free, vacant, unbooked; for booked — reserved,
occupied, sold
