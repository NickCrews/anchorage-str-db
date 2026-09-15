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
bedroom in an occupied home. The cross-source concept: a unit may have
listings on several platforms, a registration, both, or neither. No table
holds units; see [rental-units](./docs/research/rental-units/README.md) for
why grouping records into them is unsolved.
_Avoid_: property, rental, dwelling, room, STR, home

**Listing**:
One Airbnb page a guest can book, identified by `listing_id`. A unit can have
several, and one listing can cover several units.
_Avoid_: room, rental, ad, property, STR, unit

**Room type**:
Airbnb's own label for how much of a unit a listing covers: `Entire
home/apt`, `Private room`, `Shared room`, `Hotel room`. Stored verbatim. The
only place this repo says "room".
_Avoid_: listing type, property type, rental type

**Property title**:
Airbnb's short description of the building (`Cabin in Palmer`). A property
type, not a room type.

**Night**:
One date on a listing's calendar, `night_date`. The grain of
`airbnb_calendar_status`.
_Avoid_: day, date

**Stay**:
Consecutive nights booked together. Airbnb prices a stay, never a night, so
the price data is a **quote**: `quote_total` for `quote_nights` nights from
`quote_check_in`.
_Avoid_: booking, reservation, trip

### Who is involved

**Host**:
The Airbnb account a listing is run from, identified by `host_id` and stable
for the life of the account. The operator: often a property manager or
rental company listing for many owners, so a host is not an owner. Co-hosts
are not recorded.
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
The entity a license is issued to. Named on the license page as
`business_name`, and never identified: the `LC` id belongs to the license,
not to the licensee, so one business holding four licenses has four of them.
Like the owner, the licensee is a name in this data, not an identity.
_Avoid_: applicant, registrant, business, license holder

### The Municipality

**The Muni**:
The Municipality of Anchorage. "The Municipal Clerk" specifically for the
office that publishes the registration layer.
_Avoid_: the city, Anchorage, MOA, the municipality

**Registration**:
One STR certificate the Municipal Clerk publishes, identified by
`registration_id`. Required to operate a short-term rental; a listing prints
its id on the listing page, which is the only link between the two sources.
_Avoid_: permit, certificate, license, registration number, STR number

**License**:
The Muni business license a registration is issued under, read from its
CityView page. It carries what the registration layer lacks: the licensee's
own description of the business, parcel ids, and every certificate issued.
One license holds exactly one STR Certificate, so a license and a
registration are the same thing seen from two systems — see **Three ids, one
license** below.
_Avoid_: registration, permit, licence

**License location**:
One row of a license page's location list. A row with a `link` comes from a
Muni property record — label `Property` for a parcel id, `Address` for that
record's address. A row without one is text the registrant typed that matched
no record.
_Avoid_: address (unqualified), property, site

**Parcel**:
A Muni property record, identified by `parcel_id`. The join key to
[anchorage-property](https://github.com/NickCrews/anchorage-property).
_Avoid_: lot, property, tax record

**Community council**:
The Muni's neighborhood district, derived by the Muni from a registration's
point. Only registrations have one.
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
| `licensee_id` | `LC260500349` | the license page's "Licensee Number", and the layer's `ApplicationNumber` | anyone opening the license page |
| `license_id` | `13923` | the `licenseId` in that page's URL | nobody — CityView's internal row id |

The three are one-to-one-to-one. On 2026-09-15 the layer held 2,564
registrations, 2,564 distinct `license_id`s and 2,564 distinct
`licensee_id`s, with no value of any one shared across two of another. So
joining on any of them is equivalent; `license_id` is used because it keys
`muni_license_page_reads`.

**The `LC` id is not a licensee**:
It identifies one license, despite the portal labelling it "Licensee
Number". Every one of the 312 business names holding more than one
registration holds a separate `LC` id for each: SWITZER SUITES has
STR20260008-11 under LC260500044-47 and CityView ids 13615-18 — four
licenses, not one licensee with four registrations. Never group by it to
count operators.

**`registration_id`**:
`STR20260309`. On a registration it is the Clerk's; on a listing it is what
the listing page prints, which may match no registration.

### Where a thing is

**Point**:
A `lat`/`lng` pair. A listing's is Airbnb's (`location_lat`/`location_lng`);
a registration's is the Muni geocoder's (`geocoded_lat`/`geocoded_lng`).
_Avoid_: location, coordinate, position, pin, geo

**Address**:
A street address as text. A listing has one only when the host published it
(`location_exact_address`); a registration's is `registered_address`, either
a property record's or the registrant's typed text.
_Avoid_: location, street, place

**Exact**:
Of a listing's point: Airbnb's real position rather than its privacy offset.
About half are not. Filter `location_is_exact` before any spatial join.
_Avoid_: precise, real, verified, unjittered

**Jittered**:
Of a listing's point: offset by Airbnb for privacy. Stable per listing, so
repeat scraping does not average it out.
_Avoid_: fuzzed, blurred, approximate, obfuscated

**Geocoded**:
Of a registration: derived by the Muni from `registered_address`, not given
by the registrant. Applies to its point, `geocoded_address`,
`community_council` and `parcel_type`.

### Lifecycle

**Active**:
Of a listing: still appearing in search, within `RETIREMENT_GRACE_DAYS` of
the latest completed run (`is_active`, `listings_active`). Of a registration:
in the latest registry run's layer, which holds only active registrations.
The word for "still out there" everywhere, in schema and UI alike. Licenses
are valid or expired instead, and a night is operating or not; neither of
those is a synonym for this.
_Avoid_: current, live, operating, open, in service

**Retired**:
Of a listing: no longer active. The Muni equivalent is lapsed.
_Avoid_: dead, gone, removed, delisted, inactive

**Lapsed**:
Of a registration: no longer published by the Clerk, so its term ended, it
was withdrawn, or the Muni stopped publishing it. The Airbnb equivalent is
retired. Not the same as expired, which is about the license term rather
than about publication.
_Avoid_: departed, gone, expired, dropped, inactive

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
_Avoid_: lapsed, retired, inactive, dead, invalid

**Version**:
One run of unchanged attributes on a listing or host, `valid_from` to
`valid_to`. Which attributes open a version is `VERSION_KEY_SQL`.
_Avoid_: revision, snapshot, record, change

**Current version**:
The latest version of a record — `valid_to IS NULL`, or
`airbnb_calendar_status.is_current`. About the row, never about the listing:
a retired listing still has a current version.
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

Active and operating are the easiest pair to conflate, and they are at
different grains. Active is a property of a listing as of the latest run;
operating is a property of one (listing, night) pair. A retired listing is
not active, but was operating on every night before it went. An active
listing whose calendar never fetched is operating on none. "How many
short-term rentals are there" is `listings WHERE is_active`; "how many were
on the market last New Year's Eve" is `calendar_current`. Neither word
replaces the other.

**Available**:
Of a night: bookable on Airbnb's calendar. Its opposite covers both booked
and host-blocked nights, which the calendar cannot tell apart — say
"not available", and never infer occupancy without that caveat.
_Avoid_: open, free, vacant, unbooked

**Booked**:
Of a night: taken by a guest. Not directly observable; only ever an
interpretation of a night that is not available.
_Avoid_: reserved, occupied, sold

**Operating**:
Of one (listing, night) pair: that night was on the listing's calendar when
we read it, available or not. The denominator for every occupancy question.
A fact about the data rather than about the rental — a listing whose host
blocked all twelve months is operating on all of them.
_Avoid_: active, running, open, in business

**Not operating**:
Not a term, because it is not a state. A listing has no row for a night when
it had not been scraped yet, when it had already retired, when the night is
beyond Airbnb's ~12-month window, or when its calendar was never read. Only
the second is a fact about the rental, and the missing row cannot tell you
which applies, so write "no calendar data" and say which you mean.

**Portfolio**:
The listings held by one host, counted per run in `host_portfolios`. Counts
only listings inside the Anchorage search area, and no threshold separating
a hobbyist from a commercial operator is stored — that line is drawn
downstream.
_Avoid_: empire, holdings, inventory, tycoon

### Out of scope

**STR**:
Short-term rental, the subject of the database. An adjective, not a
countable thing: an "STR registration", never "2,600 STRs".
_Avoid_: using it to mean a listing or a unit

**Search area**:
The bounding box the daily run searches, covering the whole Muni including
Girdwood. Every count in this database is scoped to it.
_Avoid_: region, bbox, area of interest
