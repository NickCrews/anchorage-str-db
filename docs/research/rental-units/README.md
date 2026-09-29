# Dwellings and rooms across Airbnb and the Muni registry

As of the 2026-09-26 daily run and registry run in
`data/anchorage_str.duckdb` (the registry layer was last edited
2026-09-21). All listings are inside the Muni. Every count and example comes
from a query in [queries.sql](queries.sql). Registration ids link to the
Muni's license page, listing names and ids to Airbnb.

**Goal:** one row per dwelling, and one per room rented on its own, with
everything Airbnb and the Muni registry say about it and which of the two
sources know about it.

**Summary:**

- Neither source counts dwellings. 14% of listings are rooms, some listings
  combine other listings, and a few dwellings are listed twice. Registrants
  choose what a registration covers: one room, one dwelling or a whole
  building.
- The ordinance says a registration covers one "separate and distinct
  living unit", which includes a bedroom (§3). So one registration per room
  is what the ordinance asks for, not the exception. Most room operators do
  not do it.
- 80% of active listings print an id whose registration is where the listing
  is. The rest print no id (17%), an id the layer does not have yet (1%), or
  one for somewhere else (1.5%). Several of the wrong ones can be corrected
  from the addresses on the host's other registrations (§4).
- A dwelling table is buildable with rules and no human review. It needs
  persisted ids and an append-only record of which listings and
  registrations were assigned to which dwelling, and why (§6, §7).

---

## 1. Vocabulary

Defined in [CONTEXT.md](../../../CONTEXT.md).

- **Dwelling:** short for dwelling unit. A house, apartment, cabin or
  accessory unit that could be rented long-term. Title 21 defines a dwelling
  unit as "a building or portion thereof designed or used exclusively as the
  separate residence for one household and providing independent and
  complete living facilities, generally including provisions for sleeping,
  eating, cooking, and sanitation" ([AMC 21.15.040][t21-ch15]).
- **Room:** a room inside a dwelling, rented on its own. It is always part of
  exactly one dwelling. It cannot be rented long-term by itself, so it takes
  no housing out of the long-term market unless its whole dwelling is taken.
- **Combo listing:** a listing that covers two or more other listings, such as
  the 700 M St "Full 5BR Compound" over its three dwellings. A combo can
  itself be part of a larger combo.
- **Component listing:** a listing a combo listing covers.
- **Atomic listing:** a listing that covers no other listing. An atomic
  listing covers exactly one dwelling or one room.
- **Parcel** is already defined: a Muni property record, `parcel_id`.

**No umbrella word.** Dwellings and rooms are the only two kinds of thing a
listing can cover, so "dwelling or room" says everything an umbrella word
would. "Unit" is not used: it collides with the unit designator in
addresses, where "4011 TURNAGAIN BLVD E, Unit:4A" is a dwelling and
"400 Turpin St, Unit 8, Bedroom B" is a room in one.

**Atomic listings to dwellings and rooms is many-to-one, not one-to-one.**
Each atomic listing covers exactly one dwelling or room, but:

- **Duplicates:** a dwelling can have several atomic listings. 4011 Turnagain
  Blvd E, Units 3A and 4A, are each listed twice from two host accounts (§5).
- **No listing:** a dwelling or room can have none. It may be registered but
  not on Airbnb, or on another platform only. 729 of 2,576 active
  registrations are cited by no listing.
- **Listed both ways:** a dwelling can be listed whole and by the room. Then
  the whole-dwelling listing is a combo of the room listings, and the
  dwelling itself has no atomic listing. [STR20260377][STR20260377] (Lake
  View B&B) has a [guest house][19267486] and three private rooms under one
  registration. Whether the rooms are inside the guest house or the main
  house is not in either source.

**Two dimensions, one word each.** Whether a listing covers others and
whether it is covered by one are independent, and all four combinations
occur:

| | Covered by no combo | Covered by a combo |
| --- | --- | --- |
| **Covers no listing** | atomic, standalone (most listings) | atomic component (Bootlegger's Bungalow) |
| **Covers listings** | top-level combo (M St 5BR Compound) | combo that is also a component (M St 3BR Combo) |

"Parent/child" implies a tree. But one listing can be part of two combos:
each 700 M St dwelling is in both the 3BR Combo and the 5BR Compound. So the
relation is a graph, and "combo/component" doesn't imply otherwise.
"Divisible" describes the space, not the listing. Two counts describe a combo:

- `atomic_listings_covered`: how many atomic listings it covers (5BR
  Compound: 3);
- `dwellings_covered`: how many dwellings it covers (5BR Compound: 3; a
  whole-house listing over three room listings: 1).

Detecting combos is [#38][issue-38].

## 2. How far listings and registrations are from dwellings

### Listings

Of 2,468 active listings:

| Listing type | Listings | Share |
| --- | --- | --- |
| Entire home/apt | 2,113 | 85.6% |
| Private room | 328 | 13.3% |
| Shared room | 18 | 0.7% |
| Hotel room | 9 | 0.4% |

- **Rooms:** the 355 listings that are not an entire home come from 151
  hosts and 205 (host, registration id) pairs. So they sit in roughly 150 to
  200 dwellings. The [Ski Inn][STR20261701] is 8 room listings in one
  building, 400 Turpin St, Unit 8 is 4 in one apartment,
  and the [Shaligo host][450844916] has 11 across three houses (§4).
- **Combos:** 168 entire-home listings (6.8%) share a host and a
  registration id with another entire-home listing. Combos are among them.
  Names alone mark 13 listings as combos or whole buildings. Examples:
  "[AK Village- 4 unit combo][919861119846421474]", "[The Monarch Estate |
  Sprawling 9BR Compound][1197715784748015844]" over its 6BR upper and 3BR
  lower levels, and "[Central 7BR Gathering House][1633433716442472089]",
  which cites APT B at 1742 W 12th Ave. It appears to be that address's 4BR
  APT A and 3BR APT B together.
- **Duplicates:** the Turnagain pair in §5. How many more exist is unknown
  until combos are separated from them.

**How listing counts distort a finding.** Each of these is true of listings
and misleading about dwellings:

- **Housing taken:** "2,468 listings" is not 2,468 homes out of the
  long-term market. About 355 are rooms in roughly 150–200 dwellings. Some
  entire-home listings are combos of others. Some are duplicates.
- **Operator size:** the [700 M St host][187849202] has 63 active listings
  under 51 registration ids. At 700 M St, 6 listings cover 3 dwellings. The
  Shaligo host has 11 listings in 3 dwellings under 19 registrations. Host
  listing counts overstate hosts who list combos, and registration counts
  overstate registrants who register rooms.
- **Nights:** over the 90 nights from 2026-09-27, the 6 700 M St listings
  show 450 listing-nights not available. The three dwellings have at most
  270 dwelling-nights. Summing across listings counts each night of a booked
  or blocked compound up to 3 times.
- **Place:** by Airbnb's place name, 130 listings (5.3%) are in Girdwood. By
  coordinate it is 292 (11.8%): Airbnb labels many Girdwood listings
  "Anchorage". That is a labelling problem, not a grain problem, but it
  shows how far a listing-level field can be from the truth. By grain, the
  share stays close: 12.9% of entire-home listings, 13.7% of hosts and 12.9%
  of registrations. But only 5.4% of room listings are in Girdwood. So a
  count that mixes rooms and entire homes understates Girdwood's share of
  whole dwellings.

The first three biases all point the same way: counting listings overstates
STR activity relative to dwellings. How much depends on combo and room
detection.

### Registrations

The registry publishes no "type of living unit". The owner reports it
([AMC 10.90.020A.2](#3-what-the-ordinance-says-a-registration-covers)), but
the layer does not carry it. So the grain can only be read from the address
text and from the listings that cite a registration:

- **Rooms:** only 19 of 2,576 active registrations (0.7%) name a room. 16
  are Shaligo AK Stays and 3 are 400 Turpin St. Yet 148 registrations are
  cited by room listings: 137 only by rooms, 11 by rooms and entire homes.
  Most room operators register once for the whole dwelling, like the Ski
  Inn's one registration for 8 rooms.
- **Several dwellings on one registration:** see the combos above. 70
  registrations each cover several entire-home listings from one host. Some
  are one dwelling with combos, and some are several dwellings, such as 700
  M St.
- **Shared addresses:** the 2,576 registrations sit at 2,220 distinct
  geocoded addresses. 538 share an address with another active registration,
  with up to 15 at one. A group can be separate dwellings in one building,
  rooms of one dwelling, or duplicates (§5).
- **Citations:** 1,735 registrations are cited by exactly one listing, 112
  by two or more, and 729 by none.

Grouped by registration, the Ski Inn is 1 and 400 Turpin St is 4, though
both are rooms in one dwelling. Shaligo's three houses are 19. A
registration count is closer to a dwelling count than a listing count is,
because rooms mostly aren't registered separately. But it has no fixed
grain, and the ordinance points the other way (§3).

## 3. What the ordinance says a registration covers

The ordinance asks for one registration per separately rented space, and a
bedroom is one. It does not ask for one registration per dwelling.

[AO 2025-115(S-2)][ao-2025-115-s2], approved 2025-12-16 and corrected
2025-12-30, adds chapter 10.90 to the code:

> **10.90.010** … *Short-term rental.* A separate and distinct living unit,
> which may be a house, town home, condominium, studio unit, bedroom,
> accessory structure or any such other similar unit, offered for overnight
> occupancy in exchange for a fee and that is available for rent for fewer
> than 30 consecutive days.

> **10.90.020A.** When registering a short-term rental, the owner must
> provide all the following information about each short-term rental owned
> within the Municipality of Anchorage: 1. The street address of the
> short-term rental; 2. The type of living unit in which the short-term
> rental is located (such as a bedroom, single-family house, townhouse,
> duplex, or condominium); …

> **10.90.020C.** If the short-term rental registration is accepted by the
> Municipal clerk, the short-term rental shall be assigned an individual
> registration number that shall be listed with the short-term rental on
> any hosting platform or on any advertising medium where it is offered to
> rent.

So:

- **The thing registered is the short-term rental,** and each gets its own
  number. A bedroom rented on its own is a short-term rental. 400 Turpin
  St's one registration per bedroom, and Shaligo's, follow the ordinance
  most literally. The Ski Inn's one registration for 8 separately listed
  rooms reads as under-registration.
- **The address and the "type of living unit" are two fields,** so the
  registrant says what they are registering. The layer publishes the address
  but not the type. The Clerk's form asks, "If multiple rental units are
  located within one address, please note identifying information such as:
  Bedroom 1, Bedroom 2, Upstairs Unit" ([registration program
  page][clerk-str], read 2026-09-14). That text is where "ROOM 2" in
  Shaligo's addresses comes from.
- **Combos:** a combo listing is, in the ordinance's terms, several
  short-term rentals offered together. The ordinance doesn't say which
  number a combo should display. The M St compound prints the one
  registration its host holds for the building. 1742 W 12th Ave's 7BR
  listing prints APT B's.
- **Title 21 uses a different grain.** The zoning definition the same
  ordinance adds ([AMC 21.05.050J.7][ao-2025-115-s2]) is "a furnished
  dwelling unit, or portion thereof, that is rented out … for a period of
  fewer than 30 consecutive days." That is a dwelling or part of one, which
  matches this doc's dwelling-or-room split.
- **The enforcement hook is the listing.** 10.90.020D bars platforms from
  collecting a fee for a booking "that does not display the municipal
  registration number on the short-term rental's listing". So a listing
  with no id is non-compliant on its face. A listing with the wrong id is
  not detectable by the platform.

The introduced version ([AO 2025-115][ao-2025-115]) had the same definition
without "accessory structure". It also struck, from AMC 12.20.031, a
proposed platform report of every room rented, "whether it is a room or an
entire dwelling unit". That report would have given the Muni both grains
directly.

## 4. Linking listings to registrations

The printed registration id is the only field that names a record in the
other source. For each active listing, what it prints and how far its
coordinate is from that registration's geocoded coordinate:

| Case | Listings | Share |
| --- | --- | --- |
| Consistent: within 100 m (exact) or 300 m (jittered) | 1,976 | 80.1% |
| Beyond that but under 1 km | 10 | 0.4% |
| Over 1 km | 28 | 1.1% |
| Registration not geocoded | 9 | 0.4% |
| Id not in the layer | 18 | 0.7% |
| No id | 427 | 17.3% |

For consistent links, a jittered coordinate is a median 92 m from the
registration (90th percentile 135 m), and an exact one 7 m (30 m).

**A consistent link can still be a coarse one.** It says the listing is at
the registered address. It doesn't say which dwelling or room there.
[STR20261701] is 8 rooms, and [STR20261828] is 6 listings over 3 dwellings.
§2 has the counts.

**Ids not in the layer are mostly new.** 16 of the 18 are higher than the
highest id the layer holds (STR20262600, issued 2026-09-10). The layer was
last edited 2026-09-21. These are probably registrations issued since, not
wrong ids. They resolve once the Clerk republishes, so they need a recheck,
not a correction.

**No id: 427 listings.** They are all inside the Muni now, since the run
drops listings outside the boundary. The top host is [Evolve][121679638],
with 45 of its 50 listings showing no id. Nothing else links these listings
to a registration:

- No active listing has a street address (`location_exact_address` is NULL
  on all 2,468).
- Registrations have no bedrooms, listing type or capacity. Listings have no
  business name.
- Location is ambiguous. Count the uncited registrations within 50 m of an
  exact coordinate or 150 m of a jittered one:

  | Coordinate | 0 candidates | 1 | 2 | 3 or more |
  | --- | --- | --- | --- | --- |
  | Exact (166) | 129 | 31 | 2 | 4 |
  | Jittered (261) | 124 | 59 | 19 | 59 |

  90 have exactly one candidate. A jittered coordinate has a median of 2
  active registrations of any kind within 150 m, 9 at the 90th percentile
  and up to 43. And "uncited" assumes a cited registration can't be this
  listing's. For rooms and combos that's false.

**Wrong id: at least 28 listings.** Their coordinate is over 1 km from the
registration they print. [registration-location-mismatch][mismatch] sorts
them: most are a host printing the id of another rental they run.

- **[STR20260765], 8483 Sundi St:** 4 listings from one host.
  "[Serenity Suite][1687456614565152954]" is at the address. "[Eagle nest
  home][1668926817471594875]", "[Eagle Suite][1662003281978078076]" and
  "[Large Cabin style home sleeps 26][1687945174652662852]" are elsewhere.
  Two of them are near registrations under the host's other business name
  ([registration-location-mismatch][mismatch]).
- **[STR20262388]:** cited by "[Arbor du Nord 3 A][1447082877038361365]"
  and "[Beautifully updated city center condo!][50359680]" from two hosts.
  Its typed address names two streets and two zip codes, so the geocode or
  one of the citations is wrong.
- **[STR20260455], The Kindred House:** "[The Kindred
  House][1694492408872771235]", 5 bedrooms, and "[Brown Bear
  Place][1195142506449964239]", 1 bedroom, from different hosts. This may
  be a suite in the house or a second dwelling.

14 registration ids are cited by listings from more than one host.

**Correcting a wrong or missing id from addresses.** A listing has no
address, but a host's other listings do lead to registrations, and those
have addresses. Where a host's registrations sit at a few addresses, a
listing's coordinate can pick the address, and often the registration.

**Example: Shaligo.** [Host 450844916][450844916] has 11 room listings.
Shaligo AK Stays holds 19 registrations at three houses: 4425 E 6th Ave
([STR20262241] for the address, rooms 2, 4, 5 and 6, and [STR20262321],
typed "4425 E **5TH** AVE … ROOM 3"), 3503 E 16th Ave ([STR20262240] and
rooms 2–10) and 3706 Oregon Dr ([STR20262242], rooms 2 and 3).

| Listing | Prints | Coordinate | Nearest Shaligo address |
| --- | --- | --- | --- |
| [Budget \| Compact][1448272365447978936] | [STR20262409] (4425 E 6th, room 5) | exact | 4425 E 6th, 2 m |
| [Quiet Neighborhood][1236091388960535120] | — | exact | 4425 E 6th, 2 m |
| [Cozy\| Private Room][845722141449651508] | — | jittered | 4425 E 6th, 55 m |
| [Private Rooms \|Workspace][1272688442355424229] | [STR20262410] (4425 E 6th, room 4) | exact | **3503 E 16th, 3 m**; 4425 E 6th is 1.5 km |
| [Cozy Stay][871320890066884386] | — | jittered | 3503 E 16th, 118 m |
| 4 more at 3503 E 16th, 2 at 3706 Oregon Dr | a registration at that address | jittered | 32–135 m |

- **Wrong id:** "Private Rooms |Workspace" prints a 4425 E 6th room but
  sits, with an exact coordinate, on 3503 E 16th. The correct address is
  certain. The room isn't, because 3503 E 16th has seven uncited room
  registrations.
- **No id:** the three listings without an id each land on one Shaligo
  address.
- **Typo:** the 4425 E 5th registration is almost certainly room 3 of
  4425 E 6th.

The rule that settles these is conservative: same host, an exact
coordinate (or a jittered one inside one cluster), and exactly one
candidate address among the registrations that host's other listings cite.
It corrects the address, and so the dwelling, even when the room stays
unknown. For a dwelling table that is enough.

[registration-inference](../registration-inference/README.md) measures the
stricter question of which registration, not which address. Validated on
listings with a correct id, its rules recover 455 of 459 hidden ids. On the
460 listings with no id, an unknown id or one over 1 km away, they suggest
32 registrations. They decline Shaligo's "Private Rooms |Workspace" because
3503 E 16th has several unclaimed registrations.

## 5. Duplicate records

**Two registrations for one dwelling.** Same address, near-identical
business name:

| Address | Registrations | Business names | Listings citing |
| --- | --- | --- | --- |
| 19841 Chugach Park Dr, Chugiak | [STR20261634], [STR20262029] | Beacon Family Holdings LLC, Beacon Family LLC | 0, 1 |
| 1306 W 31st Ave | [STR20262564], [STR20262565] | Twin Peaks Rentals llc, Twin Peaks Rental llc | 0, 0 |

**Two listings and two registrations for one dwelling.** 4011 Turnagain
Blvd E, Units 3A and 4A. Each has one registration from Y&G Property
Management and one from Turnagain61, all issued 2026-07-27. Each also
has two listings: one from [host 475840157][475840157] citing the Y&G
registration, and one from [host 1699099752246775866][1699099752246775866]
citing the Turnagain61 registration. For 4A both are titled "5 mins to
Airport | Rustic & Premium 3b3bTownhome" ([1718621980118022587],
[1718609799900620065]). All four are 3 bedrooms, 8 guests. This looks
like a property manager and an owner each registering and listing the same
two dwellings. The host-to-registrant pairing is consistent, which a rule
could use.

**The same shape that is not a duplicate.** 829 E 13th Ave has three
registrations ([STR20262194], [STR20262195], [STR20262196]) with the same
business name, no unit designator and the same issue date. Two are cited,
by a [studio][50156544] and a [cabin][51602371]; the third by none. These are probably three dwellings
on one parcel. The records look like the Chugach Park duplicate, and
nothing in the registry tells the two cases apart. Parcel data could: the
assessor records how many dwellings a parcel has (§9).

## 6. Dwelling as the grain

**For:**

- It answers the housing question directly: how many homes are STRs rather
  than long-term rentals, and where.
- It is physical and stable. Dwellings rarely appear or disappear, while
  listings and registrations churn around them. That makes it the natural
  anchor for identity over time.
- Both sources reach it. Duplicates, combos and room-by-room listings fold
  into it, which no source record does alone.
- It joins to parcels, and through them to
  [anchorage-property](https://github.com/NickCrews/anchorage-property):
  zoning, assessed value, owner occupancy.
- It matches the Title 21 definition, which the Assembly's future
  regulation (zoning districts, structure types, owner-occupied) would be
  written against.

**Against:**

- Nothing observes a dwelling. Every dwelling is an inference, and its count
  moves when rules change. The table needs to say how each membership was
  decided.
- Tourism and bed-tax questions are about rooms and nights, not dwellings.
  Rooms need their own rows (the §9 decision).
- Activity data is per listing. Nights not available, prices and reviews
  must be combined per dwelling without double counting: the union of
  component nights, not their sum.
- Dwellings with neither a listing nor a registration are invisible. The
  table counts known STR dwellings, not all of them.
- Some splits are undecidable from these sources. Is 829 E 13th Ave three
  dwellings? Is 700 M St three, as the title says? Parcel dwelling counts
  help. Otherwise the table records the uncertainty rather than guessing.

On balance, dwelling should be the primary grain for housing questions,
with rooms under it and listings and registrations kept as the evidence.
Listing and registration views stay for questions that are about them
(compliance, host behaviour).

## 7. Building the dwelling table

### Tables

- `dwellings`: `dwelling_id` (assigned, never reused), `created_on`,
  `retired_on`, `merged_into` (the surviving `dwelling_id` when two turn out
  to be one), and best-known attributes (address, parcel, coordinate)
  derived from members.
- `rooms`: `room_id`, `dwelling_id`, same lifecycle columns.
- `memberships`: the audit trail. One row per assertion that a source record
  belongs to a dwelling or room:

  | Column | Meaning |
  | --- | --- |
  | `source`, `source_id` | `airbnb_listing` + `listing_id`, or `muni_registration` + `registration_id` |
  | `dwelling_id`, `room_id` | what it belongs to; `room_id` NULL for a whole-dwelling member |
  | `relation` | `is` (an atomic listing of this dwelling or room), `covers` (a combo covering it), `registers` (a registration for it) |
  | `rule`, `rule_version` | which rule decided it, e.g. `printed_id`, `same_address_unit`, `host_sibling_address`, `agent` |
  | `evidence` | a struct of the inputs: distance, matched fields, candidate count |
  | `asserted_on`, `retracted_on` | run dates; a retraction closes the row, nothing is updated in place |
  | `asserted_by` | the rule version or agent run that wrote it |

The 700 M St compound gets three `covers` rows, one per dwelling. The Ski
Inn's dwelling gets eight room rows, each with an `is` listing. Per the
§9 decision, that is the "part of" versus "listed as" distinction.

### Matching rules, strongest first

1. **Printed id, consistent location** (80% of listings). The listing joins
   whatever dwelling its registration belongs to.
2. **Registrations at one normalized address and unit designator** form one
   dwelling. Rooms named in the address ("Bedroom B", "ROOM 4") become rooms
   of it. This needs address normalization across the layer's two styles:
   parcel-record style "7730 MAYFAIR DR, Unit:APT 1" and typed text
   "525 w 3rd Ave #501". Where set, the parcel id decides the address.
3. **Host-sibling address** (§4): same host, one candidate address among
   the host's cited registrations, exact coordinate or a tight cluster.
   This also corrects wrong ids.
4. **Combo detection** ([#38][issue-38]): a combo listing becomes `covers`
   rows over the dwellings its components belong to.
5. **Spatial with one candidate:** an exact coordinate within 30 m of
   exactly one registration, of a dwelling no listing is in.
6. **Otherwise the record is its own dwelling,** flagged as known to one
   source. A dwelling known to only one source is still counted.

A registration whose listing is found elsewhere by rule 3 keeps its own
dwelling. The mismatch is recorded, not overwritten. The printed id stays
on the listing as published.

### Identity and stability

The ids come from this table, never from a source record. `airbnb:<id>`
or `str:<id>` would change when a listing adds its id, and collide when a
room is registered separately. Each run:

1. **Sticky first:** a source record with an open membership keeps it. The
   rules run only on records with none: new listings, new registrations,
   and records whose membership was retracted.
2. **New evidence merges or splits, never renumbers.** A listing that starts
   printing an id joins that registration's dwelling. If each already had a
   dwelling, the younger id is `merged_into` the older, so links to either
   keep resolving. A split keeps the id for the larger part and assigns a
   new one to the rest.
3. **Rule changes are migrations:** rerun the new rule version over all
   records, diff against open memberships, and apply the diff as
   retractions and assertions stamped with the new `rule_version`.
4. **Record churn is handled by rule 2 and the host-sibling rule.** A
   deleted and recreated listing is a new `listing_id` at the same host and
   coordinate. A lapsed and re-registered dwelling is a new registration at
   the same address.

### Audit trail

`memberships` names source ids and dates, so the observations behind a
membership are the ones for that `listing_id` or `registration_id` between
`asserted_on` and `retracted_on`, joined from the `*_observations` tables
as they stand. Nothing is copied. To see why a listing is in a dwelling,
read its open membership's `rule` and `evidence`. To see what a dwelling was
on a past date, filter memberships to that date. The dwelling table and its
counts can be rebuilt as of any run.

### No human review

The rules above run unattended. Where they leave a cluster undecided (the
Shaligo rooms, 829 E 13th Ave), an AI agent can work it, with a small blast
radius:

- It gets one cluster at a time: the records at one address or one host's
  nearby listings. It may only assert memberships for those records.
- Its rows carry `rule = 'agent'`, a confidence and its reasoning in
  `evidence`. They never retract a deterministic rule's rows.
- Each run is capped, e.g. 50 assertions. A run that would change the
  dwelling count by more than a set fraction stops instead.
- Every agent assertion can be retracted as a batch by its `asserted_by`,
  and the next run of the rules is unaffected.

The design is [#40][issue-40]. It is blocked on
[#38][issue-38] and [#39][issue-39].

## 8. Attributes when records disagree

With several records per dwelling, most attributes have more than one value:

- **Size:** the 700 M St [compound][720964186611110453] says 5 bedrooms, and
  its component listings say 2, 2 and 1. Take a dwelling's size from its
  atomic listings, not its combos. Duplicate listings can still disagree.
- **Location:** the registration's geocoded coordinate is usually better
  than a listing's, except where §4 shows the registration is the wrong one.
  An exact listing coordinate beats a geocode from mistyped text.
- **Operator:** host and registrant are different concepts (see
  [data_model.md](../../data_model.md#owners-are-not-modeled)), so both are
  kept, not coalesced.
- **Status:** a listing can be active while its registration has lapsed,
  and a registration can be active with no listing.
- **Calendar and price:** a dwelling's night is not available if any listing
  covering it is not available. Take the union, never the sum.

## 9. Decisions

- **Dwelling, room, or both?** Both. Housing policy on conversion to
  long-term rentals needs dwellings. Tourism and bed-tax policy needs rooms.
- **Is a combo listing a dwelling, or a listing that covers several?** It
  depends on what it combines. The M St triplex compound is a listing over
  3 dwellings, each of which it `covers`. The Ski Inn is one dwelling whose
  rooms are each an `is` listing. Neither creates a dwelling of its own.
- **How much manual review?** None by people. AI agents may do periodic
  work, structured so each run's blast radius is small (§7).
- **Is there an assessor or address-point dataset to normalize against?** Not
  needed for a first version: rules 1–3 run on these two sources alone. It
  would help with three things:
  1. **Dwelling counts per parcel.** The assessor records how many living
     units (dwellings) a parcel's buildings have. That answers whether 829 E 13th Ave is
     three dwellings and 700 M St three, which nothing else here can.
  2. **Addresses to parcels.** Registrations carry a parcel id only
     sometimes (1,387 of 2,576), so the rest must be matched by address. A
     canonical address list makes rule 2's normalization a lookup, not
     heuristics.
  3. **Exact coordinates to parcels.** Parcel outlines put a parcel id on
     the 853 listings with exact coordinates, the strongest spatial key
     either source can have.

  [anchorage-property](https://github.com/NickCrews/anchorage-property)
  already joins on `parcel_id`, so this may be a join rather than a new
  source.

<!-- Sources. -->

[ao-2025-115-s2]: https://www.muni.org/Departments/Assembly/SiteAssets/Pages/FOCUS-Housing/AO%202025-115%28S-2%29%2c%20As%20Corrected.pdf
[ao-2025-115]: https://www.muni.org/Departments/Assembly/SiteAssets/Pages/FOCUS-Housing/AO_2025-115_1_87524____AO_SHORT_TERM_RENTALS_9.19.25.ONBASE.REV.DOCX.pdf
[t21-ch15]: https://www.muni.org/departments/ocpd/planning/projects/t21/documents/chapter%2015.pdf
[clerk-str]: https://www.muni.org/Departments/Assembly/Clerk/Licensing/Pages/Short-Term-Rental-Registration-Program.aspx
[mismatch]: ../registration-location-mismatch/README.md
[issue-38]: https://github.com/NickCrews/anchorage-str-db/issues/38
[issue-39]: https://github.com/NickCrews/anchorage-str-db/issues/39
[issue-40]: https://github.com/NickCrews/anchorage-str-db/issues/40

<!-- Muni CityView license pages, `registrations.status_url`. -->

[STR20260377]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13990&category=B
[STR20260455]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14121&category=B
[STR20260765]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14390&category=B
[STR20261634]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15270&category=B
[STR20261701]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15340&category=B
[STR20261828]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15468&category=B
[STR20262029]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15655&category=B
[STR20262194]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15845&category=B
[STR20262195]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15846&category=B
[STR20262196]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15847&category=B
[STR20262240]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15896&category=B
[STR20262241]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15897&category=B
[STR20262242]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15898&category=B
[STR20262321]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15990&category=B
[STR20262409]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15994&category=B
[STR20262410]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15993&category=B
[STR20262564]: https://www.muni.org/CityViewPortal/License/Status?licenseId=16212&category=B
[STR20262565]: https://www.muni.org/CityViewPortal/License/Status?licenseId=16213&category=B

<!-- Airbnb listings, by listing id. -->

[19267486]: https://www.airbnb.com/rooms/19267486
[919861119846421474]: https://www.airbnb.com/rooms/919861119846421474
[1197715784748015844]: https://www.airbnb.com/rooms/1197715784748015844
[1633433716442472089]: https://www.airbnb.com/rooms/1633433716442472089
[1687456614565152954]: https://www.airbnb.com/rooms/1687456614565152954
[1668926817471594875]: https://www.airbnb.com/rooms/1668926817471594875
[1662003281978078076]: https://www.airbnb.com/rooms/1662003281978078076
[1687945174652662852]: https://www.airbnb.com/rooms/1687945174652662852
[1447082877038361365]: https://www.airbnb.com/rooms/1447082877038361365
[50359680]: https://www.airbnb.com/rooms/50359680
[1694492408872771235]: https://www.airbnb.com/rooms/1694492408872771235
[1195142506449964239]: https://www.airbnb.com/rooms/1195142506449964239
[1448272365447978936]: https://www.airbnb.com/rooms/1448272365447978936
[1236091388960535120]: https://www.airbnb.com/rooms/1236091388960535120
[845722141449651508]: https://www.airbnb.com/rooms/845722141449651508
[1272688442355424229]: https://www.airbnb.com/rooms/1272688442355424229
[871320890066884386]: https://www.airbnb.com/rooms/871320890066884386
[1718621980118022587]: https://www.airbnb.com/rooms/1718621980118022587
[1718609799900620065]: https://www.airbnb.com/rooms/1718609799900620065
[50156544]: https://www.airbnb.com/rooms/50156544
[51602371]: https://www.airbnb.com/rooms/51602371
[720964186611110453]: https://www.airbnb.com/rooms/720964186611110453

<!-- Airbnb hosts, by host id. -->

[450844916]: https://www.airbnb.com/users/show/450844916  (Shanali / Shaligo)
[187849202]: https://www.airbnb.com/users/show/187849202  (the 700 M St host)
[121679638]: https://www.airbnb.com/users/show/121679638  (Evolve)
[475840157]: https://www.airbnb.com/users/show/475840157  (Turnagain, with Y&G registrations)
[1699099752246775866]: https://www.airbnb.com/users/show/1699099752246775866  (Turnagain, with Turnagain61 registrations)
