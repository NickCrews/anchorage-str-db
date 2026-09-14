# Rental units: one row per rentable unit across Airbnb and the Muni registry

Researched 2026-09-14 against `data/anchorage_str.duckdb`. Both sources had
one day of data (2026-09-14), so the problems in §6 come from how the sources
work, not from observed history. Every count and example comes from a query
in [queries.sql](queries.sql).

**Goal:** one row per individual unit that can be rented, with the union of
what Airbnb and the Muni registry say about it, and which of the two sources
know about it.

**Summary:** The two sources describe units at different and inconsistent
grains, and the only link between them, the registration number, is missing,
wrong or shared often enough that grouping by it does not produce units. A
unit table needs:

- a definition of "unit" that handles listings that combine other listings;
- matching beyond the registration number, which location alone cannot
  settle;
- persisted unit ids, since matching is a judgment that changes over time.

---

## 1. What counts as a unit

Airbnb listings nest. A host can list a whole house and also the rooms or
suites inside it, or list each unit of a building and also a combination of
them.

**STR20261828, 700 M St (Umlaut Holdings LLC), one host, 6 listings:**

| Listing | Bedrooms | Guests |
| --- | --- | --- |
| Bootlegger's Bungalow \| Modern Triplex | 2 bedrooms | 5 |
| Sleeping Lady Retreat \| Chef's Kitchen | 2 bedrooms | 8 |
| Captain Cook's Condo \| Downtown | 1 bedroom | 4 |
| Bootleggers Landing Villa \| Luxury Loft | 2 bedrooms | 10 |
| M Street 3BR Combo \| Connected Triplex U… | 3 bedrooms | 9 |
| M Street Triplex \| Full 5BR Compound | 5 bedrooms | 16 |

The title says triplex, so there are likely 3 dwellings. Two listings combine
units, and booking the compound makes the smaller listings unavailable.

**STR20260245, Mallars House:** one "Entire home/apt" cabin and three
"Private room" listings (Mallars House 1, 2, 3). **STR20260377, Lake View
B&B:** a guest house and three private rooms. 13 registrations cited by more
than one listing mix entire homes with private rooms.

There are two useful grains, and they answer different questions:

- **Dwelling unit:** a house or apartment. Answers how much housing STRs take
  from long-term use. A house rented by the room is one dwelling.
- **Bookable space:** the smallest thing a guest can book alone, such as a
  room, a suite or one unit of a triplex. Answers capacity and nights booked.

A listing maps to one or more bookable spaces, and bookable spaces belong to
one dwelling. With a single "unit" table, listing-to-unit is many-to-many
either way.

## 2. A registration has no consistent grain

Registrants decide what one registration covers.

One registration for many rooms:

- **STR20261701, 189 Hightower Rd, Girdwood (Girdwood Delight Inn):** 8
  private-room listings ("Ski Inn - The Ridge Room", "Parkview Room", …).
- **STR20261828:** the whole triplex above.

One registration per room:

- **400 Turpin St, Unit 8:** four registrations, STR20262058 to STR20262061,
  for bedrooms A, B, C and D of one apartment. Each is cited by one "Private
  Room-A/B/C/D" listing.
- **4425 E 6th Ave (Shaligo AK Stays):** five registrations, one for the
  address and one each for rooms 2, 4, 5 and 6 (§4).

One registration per dwelling, as the ordinance intends:

- **1742 W 12th Ave:** STR20261146 for APT A, STR20261147 for APT B.

So registration-to-unit is many-to-many too. Grouping listings by
registration number merges the Ski Inn's 8 rooms into one unit and keeps
Turpin St's 4 rooms as 4.

## 3. Duplicate records in each source

**Two registrations for one unit.** Same address, near-identical business
name:

| Address | Registrations | Business names | Airbnb listings citing |
| --- | --- | --- | --- |
| 19841 Chugach Park Dr, Chugiak | STR20261634, STR20262029 | Beacon Family Holdings LLC, Beacon Family LLC | 0, 1 |
| 1306 W 31st Ave | STR20262564, STR20262565 | Twin Peaks Rentals llc, Twin Peaks Rental llc | 0, 0 |

**Two listings and two registrations for one unit.** 4011 Turnagain Blvd E,
Unit 4A: STR20262180 (Y&G Property Management) and STR20262182
(Turnagain61), both issued 2026-07-27. Each is cited by one listing, from two
different host accounts, both titled "5 mins to Airport | Rustic & Premium
3b3bTownhome", 3 bedrooms, 8 guests. Unit 3A has the same pair, STR20262179
and STR20262181, with the same two business names. This looks like a
property manager and an owner each registering and listing the same units.

**The same shape that is not a duplicate.** 829 E 13th Ave: three
registrations (STR20262194 to STR20262196), same business name, no unit
designator, same issue date. Each is cited by one listing from one host,
titled as a studio, a house and a cabin. These are probably three buildings
on one lot. The records look like the Chugach Park duplicate, and nothing in
the registry tells the two cases apart.

Of 2,538 current registrations the geocoder matched, 2,040 have a geocoded
address no other current registration has. The other 498 share one with 1 to
9 others. Each group can be separate units, rooms of one unit, or duplicates.

## 4. Records with no registration number

554 current listings show no number and 18 show one that is not in the
registry. 690 current registrations have no listing.

**Some listings are outside the Muni.** Airbnb's search covers more than the
Municipality: 47 unnumbered listings are in Hope, 34 in Palmer and 19 in
Wasilla. They will never match a registration. Evolve has 51 listings, and 46
of them show no number, including some in Wasilla.

**Location is the only field both sources share, and it is imprecise.**

- No current listing has a street address (`location_exact_address` is NULL
  on all 2,619).
- For listings linked by number, the distance from the Airbnb pin to the
  license's geocoded point is:

  | Pin | Listings | Median | 90th percentile |
  | --- | --- | --- | --- |
  | Exact | 677 | 7 m | 31 m |
  | Approximate | 1,361 | 92 m | 136 m |

- Registrations have no bedrooms, room type or capacity. Listings have no
  business name, and the host name is usually a first name ("Troy") or a
  company ("Evolve"). Nothing else can confirm a match.

**Spatial matching is ambiguous.** Take the 464 unlinked listings in
Anchorage, Girdwood, Eagle River or Chugiak and the 688 geocoded registrations
with no listing. Count registrations within 50 m of an exact pin or 150 m of
an approximate one:

| Pin | 0 candidates | 1 | 2 | 3 or more |
| --- | --- | --- | --- | --- |
| Exact (178) | 133 | 34 | 6 | 5 |
| Approximate (286) | 134 | 58 | 24 | 70 |

Only 92 have exactly one candidate. That count also assumes a registration
already cited by a listing cannot be this listing's unit, which §1 and §2
show is false for rooms. Counting all current registrations, an approximate
pin has a median of 2 within 150 m, 10 at the 90th percentile and at most 43.

**Example: 4425 E 6th Ave.** Host Shaligo has 14 listings (12 private rooms,
2 entire homes) and none shows a number. The Muni has 5 registrations at that
address, none cited by a listing:

| Registration | Location as typed |
| --- | --- |
| STR20262241 | 4425 E 6TH AVE, ANCHORAGE, AK 99508 |
| STR20262322 | 4425 E 6TH AVE ANCHORAGE ALASKA, 99508, ROOM 2, Anchorage AK 99508 |
| STR20262410 | … ROOM 4, ANCHORAGE AK 99508 |
| STR20262409 | … ROOM 5, ROOM 5, Anchorage AK 99508 |
| STR20262408 | … ROOM 6, ROOM 6, ANCHORAGE AK 99508 |

Two listings with exact pins, 1448272365447978936 ("Budget | Compact |
Self-Check-in") and 1236091388960535120, are 2 m from the address. Two more
with approximate pins are 55 m and 109 m away. The other 10 are 1.5 to 7.4 km
away, so the host runs at least three properties and only one is registered.
The four nearby listings are almost certainly at 4425 E 6th Ave, but neither
source says which room each one is, or whether STR20262241 is the whole house
or a fifth room.

## 5. Links that are wrong

A matching number does not guarantee the listing is the registered unit. 30
linked listings have a pin more than 1 km from the license's geocoded point.
[registration-location-mismatch](../registration-location-mismatch/README.md)
sorts them into three problems: 15 likely show the wrong number, 10 share a
number with a listing at the registered address, and 5 are not near the
registered address at all. On 2026-09-14 its report was emailed to the
Municipal Clerk's Office, asking them to look into these cases and have the
hosts correct their listings.

- **STR20260765, 8483 Sundi St (Joe Dudley):** 4 listings. "Serenity Suite"
  has an exact pin. "Eagle nest home 《6 bedrooms》" and "Eagle Suite" have
  pins 29 km from Sundi St, about 100 m from two registrations named
  "Northern Stay", the host of all four listings. Those two listings likely
  show the wrong number.
- **STR20262388:** cited by listings from two hosts, "Arbor du Nord 3 A One
  Bedroom Apt." and "Beautifully updated city center condo!". The registrant
  typed "4030 San Roberto Avenue, West 15th Avenue, AK, 99501, Apartment C,
  Anchorage AK 99508", which names two streets and two zip codes. The condo's
  pin is 45 km from the geocoded point. Either the geocode or one of the
  citations is wrong.
- **STR20260455, The Kindred House:** "The Kindred House", 5 bedrooms, and
  "Brown Bear Place", 1 bedroom, from different hosts. This may be a suite
  inside the house or a second unit.

15 registration numbers are cited by listings from more than one host.

## 6. Identity over time

A unit needs an id that stays the same while its records change. With one
day of data none of these is measured yet, but each follows from how the
sources work:

- **A listing adds or drops its number.** An "Airbnb only" unit and a
  "registry only" unit become one unit. An id taken from either record, such
  as `airbnb:<listing_id>` or `str:<registration_number>`, changes or
  collides.
- **A host deletes and recreates a listing.** The new `listing_id` belongs to
  the same unit.
- **A registration lapses and the unit registers again.** Whether a renewal
  keeps its number is unknown until the data spans an expiry.
- **A combo listing appears or is removed** while its component listings stay.
- **Matching rules or thresholds change**, or a new record arrives near an
  existing match, and the grouping changes.

The project's views re-derive everything from raw tables on each run. A
recomputed grouping cannot keep ids stable, so units need a persisted table
that assigns ids and records which source records belong to each unit.

## 7. Attributes when records disagree

With several records per unit, most attributes have more than one value:

- **Size:** the 700 M St compound says 5 bedrooms and its component listings
  say 2, 2 and 1. Duplicate listings can disagree with each other.
- **Location:** the license's geocoded point is usually better than an Airbnb
  pin, but §5 shows cases where it is wrong.
- **Operator:** host and registration business name are different concepts
  (see [data_model.md](../../data_model.md#owners-are-not-modeled)), so both
  are kept, not coalesced.
- **Status:** a listing can be current while its registration has lapsed, and
  a registration can be current with no listing.
- **Calendar and price:** a booked compound blocks its component listings, so
  summing booked nights across listings counts one stay several times.

## 8. What each option does with these cases

**B: group by registration number, or by listing when there is none.** The
grouping is well defined, but its rows are often not units:

| Case | B produces | Probable units |
| --- | --- | --- |
| Ski Inn, STR20261701 | 1 | 8 rooms in 1 building |
| 700 M St triplex | 1 | 3 dwellings |
| 400 Turpin St, Unit 8 | 4 | 4 rooms in 1 dwelling |
| 4011 Turnagain Blvd E, 4A | 2 | 1 |
| 4425 E 6th Ave | 9 (4 nearby listings + 5 registrations) | 1 house, 4 or 5 rooms |
| Sundi St, STR20260765 | 1 | 2 properties |

On 2026-09-14, B would produce about 3,120 rows: 2,549 registrations plus 572
listings with no matching number. The id changes when a listing adds its
number.

**C: entity resolution.** Cases like these can be resolved, but that requires:

1. **A unit definition.** A dwelling table with bookable spaces under it, or
   one table at a single chosen grain (§1).
2. **Persisted tables:** `units` with assigned ids, and a membership table
   (source record, unit, match method, confidence, date). Listing membership
   is many-to-many for combo listings.
3. **Matching rules in order of strength:** registration number, then
   registrations at the same normalized address and unit, then spatial
   proximity with a distance set by pin precision (§4).
4. **Address normalization** across the registry's two styles (parcel-record
   style "7730 MAYFAIR DR, Unit:APT 1" and typed text "525 w 3rd Ave #501"),
   and ideally parcel ids, which are set on 457 of 2,549 current registrations.
5. **A manual override table** for cases the rules cannot decide, such as the
   Shaligo rooms and the 829 E 13th Ave lot, plus a way to review candidates.
   [apify-addresses/review.html](../apify-addresses/review.html) is a prior
   review page.
6. **Unmatched records kept as units.** A unit known to only one source is
   still a unit, with a flag saying which sources know it.

## Open questions

- Dwelling unit, bookable space, or both?
- Should a combo listing be a unit, or a listing that covers several units?
- How much manual review is acceptable, and who does it?
- Is there an assessor or address-point dataset to normalize addresses
  against? It would raise the match rate more than any rule on these two
  sources.
