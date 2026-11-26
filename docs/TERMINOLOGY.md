# Anchorage STR

A daily record of short-term rentals in the Municipality of Anchorage, built
from Airbnb's public pages, the Municipality's STR registrations, and the
Muni's parcels. Airbnb and the Muni share no key but the registration id a
listing prints on its page; a registration's license names its parcel. See
[methodology](./methodology.md).

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

**Dwelling**:
Short for dwelling unit: a house, apartment, cabin or accessory unit that
could be rented long-term — Title 21's "separate residence for one household"
with its own sleeping, eating, cooking and sanitation. What it is used for is
a separate question: a dwelling may be a short-term rental, a long-term
rental, or owner-occupied, and nothing here sees the ones that are not STRs.
The cross-source concept: a dwelling may have listings on several platforms,
a registration, both, or neither. No table holds dwellings yet; see
[rental-units](./research/rental-units/README.md) for the design
([#40](https://github.com/NickCrews/anchorage-str-db/issues/40)).
_Avoid_: unit, property, rental, home, STR

**Room**:
A room inside a dwelling, rented on its own. Always part of exactly one
dwelling, and never rentable long-term by itself, so it takes no housing off
the long-term market unless its whole dwelling goes with it. Dwellings and
rooms are the only two kinds of thing a listing covers.
_Avoid_: unit, bedroom (except quoting a source), space

**STR**:
Short-term rental: a dwelling or room rented out for stays shorter than 30
days, which is what the Muni requires a registration for — the ordinance's
"separate and distinct living unit", which explicitly includes a bedroom. As
with dwellings above, this database cannot give an accurate picture of these;
estimate from listings and registrations, which are what it holds. An
adjective, not a countable thing: an "STR registration", never "2,600 STRs".
_Avoid_: using it to mean a listing, a dwelling or a room

**Listing**:
One Airbnb page a guest can book, identified by `listing_id`. Neither
direction is one-to-one, and both counterexamples are in the data rather than
hypothetical: one dwelling can carry several listings on one platform — 4011
Turnagain Blvd E Unit 4A is listed twice, by a property manager and by the
owner, from two host accounts — and one listing can cover several dwellings —
STR20261828's triplex is listed whole as well as by dwelling, and booking the
whole makes the others unavailable. See
[rental-units](./research/rental-units/README.md).
_Avoid_: room, rental, ad, property, STR, unit

**Combo listing**, **component listing**, **atomic listing**:
A **combo listing** covers two or more other listings. The listings it
covers are its **component listings**. An **atomic listing** covers no other
listing, and so covers exactly one dwelling or one room. Whether a listing
covers others and whether it is covered by one are independent questions,
and a listing can be a component of several combos, so this is a graph, not
a tree.

The 700 M St triplex (STR20261828), by bedroom count:

| Listing | Bedrooms | Covers | Covered by |
| --- | --- | --- | --- |
| Bootlegger's Bungalow | 2 | — (atomic) | 3BR Combo, 5BR Compound |
| Captain Cook's Condo | 1 | — (atomic) | 3BR Combo, 5BR Compound |
| Sleeping Lady Retreat | 2 | — (atomic) | 5BR Compound |
| M Street 3BR Combo | 3 | Bungalow, Condo | 5BR Compound |
| M Street Triplex \| Full 5BR Compound | 5 | all of the above | — |

The three atomic listings are the triplex's three dwellings. The 3BR Combo
is both a combo and a component. Nothing in the data marks a combo yet
([#38](https://github.com/NickCrews/anchorage-str-db/issues/38)); the sixth
listing at the address, Bootleggers Landing Villa, fits none of these slots
and is undecided.
_Avoid_: parent/child listing, bundle, package, divisible

**Listing type**:
How much of a dwelling a listing covers, `listing_type`. The values are
Airbnb's display text, stored verbatim: `Entire home/apt`, `Private room`,
`Shared room`, `Hotel room`. Airbnb's own key is `roomType`, which is why the
parser reads that word and nothing else does — the concept belongs to the
listing, and it is Airbnb's alone. It is not the dwelling-or-room split: an
`Entire home/apt` listing can be a combo over several dwellings, and Airbnb
labels some apartments `Private room`.
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
The legal owner of a dwelling or room. What this database has is the
**owner of record**: `property_parcels.owner_name`, the name the Muni's parcel
records give the owner of a parcel, with their mailing address. It reaches a
listing only through the listing's registration and that registration's
parcel. A name, not an identity, and the owner of the whole parcel, which
may hold several dwellings. Never substitute host or registrant for it.
_Avoid_: using it for host or registrant; landlord, taxpayer

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
**owner**) and what is counted (**listings** or **dwellings**). A host listing
portfolio and an owner dwelling portfolio are different measurements. This
database computes the first; the second can only be approximated, by
grouping registered parcels on the owner of record's name.

A portfolio is everything the party holds, wherever it is. A host running
forty dwellings from Palmer has a portfolio of forty, and that is the number an
operator question wants. No threshold separating a hobbyist from a commercial
operator is stored — that line is drawn downstream.

`host_listing_portfolios` does not yet hold that number. It counts only the
listings we scrape, which are the ones inside the Municipality, because
nothing Airbnb publishes to us carries a host's total — see
[#34](https://github.com/NickCrews/anchorage-str-db/issues/34). That is a gap
to close, not what the word means: until it closes, call what the view holds
an **Anchorage host listing portfolio** and never a portfolio unqualified.
_Avoid_: empire, holdings, inventory, tycoon

### The Municipality

**The Muni**:
The Municipality of Anchorage. "The Municipal Clerk" specifically for the
office that published the registration layer. Its boundary is the scope of
this database: the Airbnb scrape searches a padded bounding box that also takes
in Hope, Palmer and Wasilla, and drops every listing whose coordinate falls
outside the boundary itself, so every count here is a count inside the Muni.
_Avoid_: the city, Anchorage, MOA, the municipality

**Registration**:
One STR Certificate number on a Short-Term Rentals license page, identified
by `registration_id`. Required to operate a short-term rental; a listing
prints its id on the listing page, which is the only link between the two
sources. Registrations the archived registration layer holds and no license
page shows are registrations too, and are not active.
_Avoid_: permit, certificate, license, registration number, STR number

**What a registration covers** has no fixed grain, so do not treat any tuple
— (registrant, address), (registrant, address, listing type), or another — as
its key. The registrant decides what to file, and both directions occur:

- One registration, many rooms: STR20261701, the Ski Inn (189 Hightower
  Rd, Girdwood), covers 8 private-room listings.
- One registration, many dwellings: STR20261828 (700 M St) covers a
  triplex and the combo listings over it.
- Many registrations, one dwelling and one registrant: 7901 Highlander Dr holds
  four registrations under Nordic Lodgings LLC, all with the same address
  string, and 400 Turpin St Unit 8 holds one per bedroom.

The ordinance (AMC 10.90.010, from AO 2025-115(S-2)) asks for one
registration per "separate and distinct living unit", bedrooms included, so
Turpin St is the literal reading and the Ski Inn the exception; see
[rental-units](./research/rental-units/README.md).

On 2026-09-15, 115 (registrant, address) pairs held more than one of the
2,564 active registrations in the registration layer, covering 293 of them.

**License**:
The Muni business license a registration is issued under, read from its
CityView page. It carries what the registration layer lacks: the licensee's
own description of the business, parcel ids, and every certificate issued.
One license holds exactly one STR Certificate, so a license and a
registration are the same thing seen from two systems — see **Three ids, one
license** below. The portal publishes licenses of other types under the same
ids — Business and Alcohol among them — and those hold no registration.
_Avoid_: registration, permit, licence

**Issuance**:
One row of a license page's Issuances table: a certificate or license
issued under the license, with its type (`STR Certificate`, `Business
License`), dates, status and number. An STR Certificate's number is the
`registration_id`.
_Avoid_: certificate (except for the STR Certificate itself), permit

**Submittal**:
One row of a license page's Submittals table: something the licensee filed
for the Muni to review, such as `1 Private Detective 10/13/2026`, `Pending`.
_Avoid_: document, attachment, filing

**Hidden license id**:
A `cityview_license_id` whose page is the portal's "Invalid License" page
("License Not Found"): never issued, or not public. Most ids are hidden. A
hidden id is a result of reading it, not a failed read.
_Avoid_: invalid license, missing license, deleted license

**Parcel**:
A Muni property record, identified by `parcel_id`: the Muni's 11-digit
Parcel_ID (`07606227000`), which a license page's Property location holds.
`property_parcels` holds each parcel's current state, copied daily from
anchorage-property; a license names its parcel by `parcel_id` when its page
lists exactly one.
_Avoid_: lot, property, tax record

**Parcel type**:
A registration's `parcel_type`, and a license's `parcel__property_type`: its
parcel's appraisal grouping, anchorage-property's `property_type`
(`RESIDENTIAL`, `CONDO`, `APARTMENT`, `VACANT LAND`, `COMMERCIAL`, ...). A
registration whose
license's parcel is not in `property_parcels` takes the archived
registration layer's `ParcelType` instead (`Residential`, `Commercial`),
which the Muni derived from the registered address. The two vocabularies
differ, so compare values within one. A registration with neither has none.
_Avoid_: property type (except quoting anchorage-property's column), land
use, zoning, class

**anchorage-property**:
A separate project,
[anchorage-property](https://github.com/NickCrews/anchorage-property), that
reads the Muni's parcel layer daily, keeps every parcel's history, and
publishes it as a DuckDB file. The source of `property_parcels` and the
`property_` tables. This repo copies its current parcels and reads nothing
about parcels from the Muni itself.
_Avoid_: the assessor, CAMA, the property database

**Community council**:
The Muni's neighborhood district containing a license's geocoded
coordinate, from the Muni's council polygons (`community_council`).
Licenses and their registrations have one, and a listing has its
registration's (`registration_community_council`).
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
names one dwelling, one room, one listing or one registrant. What a registration covers is
the question above, and the answer there is that it has no fixed grain.
On 2026-09-15 the layer held 2,564
registrations, 2,564 distinct `license_id`s and 2,564 distinct
`cityview_license_id`s, with no value of any one shared across two of
another, so joining on any of them is equivalent.

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
a license's or registration's is the Muni geocoder's (`geocoded_lat`/`geocoded_lng`).
ArcGIS's own "point layer" stays verbatim, as a source's label does.
_Avoid_: point, location, position, pin, geo

**Address**:
A street address as text. A license's is `address`, either a property
record's or the licensee's typed text, and its registration carries it as
`registered_address`; a listing showing that registration's id carries it as
`registration_address`. Airbnb's own `location_exact_address` is set only
when the host published one, which almost none do. A parcel's is
`parcel_address`.
_Avoid_: location, street, place

**Exact and jittered**:
Whether a listing's coordinate is its real position (`location_is_exact`) or
one Airbnb has offset for privacy. A jittered coordinate is offset by
0.0002° to 0.0012° on each axis
([research](research/airbnb-jitter/README.md)).
_Avoid_: for exact — precise, real, verified, unjittered; for jittered —
fuzzed, blurred, approximate, obfuscated

**Geocoded**:
Of a license or registration: derived from its address by the Muni's
geocoder rather than given by the licensee — its coordinate,
`geocoded_address` (the address as the geocoder writes it), and the
`community_council` containing the coordinate. The license scrape asks the
geocoder about each license's address once (`muni_address_geocodes`). A
**match** places the address itself; an answer that places only its street,
or no answer, is no match, and the geocoded columns are NULL. A registration
whose license has no match takes the archived registration layer's
geocoding instead.
_Avoid_: located, mapped, resolved

### Lifecycle

**Operating**:
Of a dwelling or room: actually rented out as an STR. A fact about the
world, which this database can only estimate. A dwelling or room can
operate with no listing and no registration, and then it is invisible here. The nearest
thing we observe is an active listing, which is evidence of operating but
not proof: a listing can stay in search while its host takes no bookings.
Operating describes the dwelling or room; active describes a record.
_Avoid_: active, running, in business, live

**Active**:
Of a listing: still appearing in search, within `RETIREMENT_GRACE_DAYS` of
the latest completed run (`is_active`, `listings_active`). Of a registration:
its STR Certificate's status is `Active` on the latest read of its license
page. Of a license (`licenses.is_active`): its most recent issuance's status
is `Active` or `Issued`.
The word for "still out there" in schema and UI alike, at the grain of one
record: a listing was active from June 2025, a dwelling is operating. Licenses
are valid or expired instead; neither is a synonym for this.
_Avoid_: current, live, operating, open, in service

**Inactive**:
Of a listing: no longer active. The Muni equivalent is lapsed. **Retire** is
the transition into it, five days (`RETIREMENT_GRACE_DAYS`) after the last
run that saw the listing; `airbnb_scrape_runs.listings_retired` counts the
listings that went inactive on that run.
_Avoid_: dead, gone, removed, delisted, expired

**Lapsed**:
Of a registration: not active. Its STR Certificate's status is something
other than `Active`, or no license page shows its number and only the
archived registration layer holds it. The Airbnb equivalent is inactive. Not
the same as expired, which is a date test on the license term rather than
the Muni's status.
_Avoid_: departed, gone, expired, dropped, retired

**Valid**:
Of a license: today is on or before its `expires_date`. A date test, not a
status — every STR license expires 2027-04-30 whatever month it was issued
in, so a license issued in August is valid for nine months and one issued in
May for twelve. The page's own `Active` text is the Muni's word, stored
verbatim in `license_status`, and is not this one.
_Avoid_: active, current, live, in force, good standing

**Expired**:
Of a license: past its `expires_date`. Says nothing about the
certificate's status: expired is a date test, lapsed the Muni's status, and a
registration can be either without the other until a renewal is observed.
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
`*_runs` table. Each source's run is its **scrape**, started with `pnpm
scrape <source>` and logged in `<source>_scrape_runs`: the **Airbnb scrape**
(`airbnb_scrape_runs`) reads Airbnb; the **license scrape**
(`muni_license_scrape_runs`) reads the Muni's license pages; the **parcel
scrape** (`property_parcel_scrape_runs`) copies anchorage-property's current
parcels. A **registry run**, logged in `muni_str_registry_runs`, read the
Clerk's registration layer; the layer answers only with a token, so those
rows are an archive. A run records a whole day or nothing.
_Avoid_: job, crawl, batch, pass (a pass is one stage within a run)

**Seen**:
Of a listing: present in a run's results. Of a registration: its number on
a license page read, or, for one only the archive holds, in a registry run's
layer (`first_seen_date`, `last_seen_date`). Distinct from read.
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

**FREH**:
Frequently rented entire-home: the housing-research test for an entire home
probably being used mainly as a short-term rental, as opposed to someone's
home or long-term rental that is only rented out now and then. A FREH
listing is housing stock that is an opportunity for conversion to long-term
housing. Over 365 past nights, an
`Entire home/apt` listing open or booked at least 183 of them and booked at
least 90. Only the industry-standard definition, at the full 365 nights;
anything scaled or shortened is FREHM. "Booked" is an interpretation of not
available (above), so FREH is an estimate. A test of listings, not
dwellings: a dwelling with two listings counts twice, and a combo listing
counts on top of its component listings. `est_listing_frehm.is_freh` in the
viewer, NULL until a listing has 365 past nights on record.
_Avoid_: commercial STR, full-time STR, ghost hotel, lost unit

**FREHM**:
FREH modified: the FREH test over the past nights on record, up to the
last 365, with both thresholds scaled to that many nights. No answer below
28 nights. Equal to FREH at 365 nights. `est_listing_frehm.is_frehm` in
the viewer, one row per listing per model, with the counts the test reads
and the reason in words (`frehm_reason`).
_Avoid_: FREH (for this), provisional FREH, estimated FREH
