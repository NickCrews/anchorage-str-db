# Rental units: one row per rentable unit across Airbnb and the Muni registry

Researched 2026-09-14 against `data/anchorage_str.duckdb`. Both sources had
one day of data (2026-09-14), so the problems in §6 come from how the sources
work, not from observed history. Every count and example comes from a query
in [queries.sql](queries.sql). Registration numbers link to the Muni's
license page, listing names and ids to Airbnb.

**Goal:** one row per individual unit that can be rented, with the union of
what Airbnb and the Muni registry say about it, and which of the two sources
know about it.

**Summary:** The two sources describe units at different and inconsistent
grains, and the only link between them, the registration id, is missing,
wrong or shared often enough that grouping by it does not produce units. A
unit table needs:

- a definition of "unit" that handles listings that combine other listings;
- matching beyond the registration id, which location alone cannot
  settle;
- persisted unit ids, since matching is a judgment that changes over time.

---

## 1. What counts as a unit

Airbnb listings nest. A host can list a whole house and also the rooms or
suites inside it, or list each unit of a building and also a combination of
them.

**[STR20261828], 700 M St (Umlaut Holdings LLC), [one host][187849202], 6
listings:**

| Listing | Bedrooms | Guests |
| --- | --- | --- |
| [Bootlegger's Bungalow \| Modern Triplex][645953498616566832] | 2 bedrooms | 5 |
| [Sleeping Lady Retreat \| Chef's Kitchen][671779791243926274] | 2 bedrooms | 8 |
| [Captain Cook's Condo \| Downtown][645953306917476922] | 1 bedroom | 4 |
| [Bootleggers Landing Villa \| Luxury Loft][720964216940577112] | 2 bedrooms | 10 |
| [M Street 3BR Combo \| Connected Triplex U…][656318860846776577] | 3 bedrooms | 9 |
| [M Street Triplex \| Full 5BR Compound][720964186611110453] | 5 bedrooms | 16 |

The title says triplex, so there are likely 3 dwellings. Two listings combine
units, and booking the compound makes the smaller listings unavailable.

**[STR20260245], Mallars House:** one "Entire home/apt" [cabin][31538594]
and three "Private room" listings (Mallars House [1][31236596],
[2][31242415], [3][31242634]). **[STR20260377], Lake View B&B:** a [guest
house][19267486] and three private rooms. 13 registrations cited by more than
one listing mix entire homes with private rooms.

There are two useful grains, and they answer different questions:

- **Dwelling unit:** a house or apartment. Answers how much housing short-term
  rentals take from long-term use. A house rented by the room is one dwelling.
- **Bookable space:** the smallest thing a guest can book alone, such as a
  room, a suite or one unit of a triplex. Answers capacity and nights booked.

A listing maps to one or more bookable spaces, and bookable spaces belong to
one dwelling. With a single "unit" table, listing-to-unit is many-to-many
either way.

## 2. A registration has no consistent grain

Registrants decide what one registration covers.

One registration for many rooms:

- **[STR20261701], 189 Hightower Rd, Girdwood (Girdwood Delight Inn):** 8
  private-room listings ("[Ski Inn - The Ridge Room][13381871]",
  "[Parkview Room][13381405]", …).
- **[STR20261828]:** the whole triplex above.

One registration per room:

- **400 Turpin St, Unit 8:** four registrations, [STR20262058],
  [STR20262059], [STR20262060] and [STR20262061], for bedrooms A, B, C and D
  of one apartment. Each is cited by one "Private Room-A/B/C/D" listing
  ([A][602098142436002853], [B][598662303426408263],
  [C][602107868115855878], [D][637685143676434419]).
- **4425 E 6th Ave (Shaligo AK Stays):** five registrations, one for the
  address and one each for rooms 2, 4, 5 and 6 (§4).

One registration per dwelling, as the ordinance intends:

- **1742 W 12th Ave:** [STR20261146] for APT A, [STR20261147] for APT B.

So registration-to-unit is many-to-many too. Grouping listings by
registration id merges the Ski Inn's 8 rooms into one unit and keeps
Turpin St's 4 rooms as 4.

## 3. Duplicate records in each source

**Two registrations for one unit.** Same address, near-identical business
name:

| Address | Registrations | Business names | Airbnb listings citing |
| --- | --- | --- | --- |
| 19841 Chugach Park Dr, Chugiak | [STR20261634], [STR20262029] | Beacon Family Holdings LLC, Beacon Family LLC | 0, 1 |
| 1306 W 31st Ave | [STR20262564], [STR20262565] | Twin Peaks Rentals llc, Twin Peaks Rental llc | 0, 0 |

**Two listings and two registrations for one unit.** 4011 Turnagain Blvd E,
Unit 4A: [STR20262180] (Y&G Property Management) and [STR20262182]
(Turnagain61), both issued 2026-07-27. Each is cited by one listing
([1718621980118022587] and [1718609799900620065]), from two different host
accounts, both titled "5 mins to Airport | Rustic & Premium 3b3bTownhome", 3
bedrooms, 8 guests. Unit 3A has the same pair, [STR20262179] and
[STR20262181], with the same two business names. This looks like a
property manager and an owner each registering and listing the same units.

**The same shape that is not a duplicate.** 829 E 13th Ave: three
registrations ([STR20262194], [STR20262195], [STR20262196]), same business
name, no unit designator, same issue date. Each is cited by one listing from
one host, titled as a [studio][50156544], a [house][51688541] and a
[cabin][51602371]. These are probably three buildings
on one lot. The records look like the Chugach Park duplicate, and nothing in
the registry tells the two cases apart.

Of 2,538 active registrations the geocoder matched, 2,040 have a geocoded
address no other active registration has. The other 498 share one with 1 to
9 others. Each group can be separate units, rooms of one unit, or duplicates.

## 4. Records with no registration id

554 active listings show no id and 18 show one that is not in the
registry. 690 active registrations have no listing.

**Some listings are outside the Muni.** Airbnb's search covers more than the
Municipality: 47 unnumbered listings are in Hope, 34 in Palmer and 19 in
Wasilla. They will never match a registration. [Evolve][121679638] has 51
listings, and 46 of them show no id, including some in Wasilla.

**Location is the only field both sources share, and it is imprecise.**

- No active listing has a street address (`location_exact_address` is NULL
  on all 2,619).
- For listings linked by id, the distance from the Airbnb pin to the
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
show is false for rooms. Counting all active registrations, an approximate
pin has a median of 2 within 150 m, 10 at the 90th percentile and at most 43.

**Example: 4425 E 6th Ave.** Host [Shanali][450844916] has 14 listings (12
private rooms, 2 entire homes) and none shows an id. The Muni has 5
registrations at that address, none cited by a listing:

| Registration | Location as typed |
| --- | --- |
| [STR20262241] | 4425 E 6TH AVE, ANCHORAGE, AK 99508 |
| [STR20262322] | 4425 E 6TH AVE ANCHORAGE ALASKA, 99508, ROOM 2, Anchorage AK 99508 |
| [STR20262410] | … ROOM 4, ANCHORAGE AK 99508 |
| [STR20262409] | … ROOM 5, ROOM 5, Anchorage AK 99508 |
| [STR20262408] | … ROOM 6, ROOM 6, ANCHORAGE AK 99508 |

Two listings with exact pins, [1448272365447978936] ("Budget | Compact |
Self-Check-in") and [1236091388960535120], are 2 m from the address. Two more
with approximate pins are 55 m and 109 m away. The other 10 are 1.5 to 7.4 km
away, so the host runs at least three properties and only one is registered.
The four nearby listings are almost certainly at 4425 E 6th Ave, but neither
source says which room each one is, or whether STR20262241 is the whole house
or a fifth room.

## 5. Links that are wrong

A matching registration id does not guarantee the listing is the registered
unit. 30 linked listings have a pin more than 1 km from the license's
geocoded point.
[registration-location-mismatch](../registration-location-mismatch/README.md)
sorts them into three problems: 15 likely show the wrong id, 10 share an
id with a listing at the registered address, and 5 are not near the
registered address at all. On 2026-09-14 its report was emailed to the
Municipal Clerk's Office, asking them to look into these cases and have the
hosts correct their listings.

- **[STR20260765], 8483 Sundi St (Joe Dudley):** 4 listings. "[Serenity
  Suite][1687456614565152954]" has an exact pin. "[Eagle nest home 《6
  bedrooms》][1668926817471594875]" and "[Eagle
  Suite][1662003281978078076]" have pins 29 km from Sundi St, about 100 m
  from two registrations named
  "Northern Stay", the host of all four listings. Those two listings likely
  show the wrong id.
- **[STR20262388]:** cited by listings from two hosts, "[Arbor du Nord 3 A
  One Bedroom Apt.][1447082877038361365]" and "[Beautifully updated city
  center condo!][50359680]". The registrant typed "4030 San Roberto Avenue,
  West 15th Avenue, AK, 99501, Apartment C,
  Anchorage AK 99508", which names two streets and two zip codes. The condo's
  pin is 45 km from the geocoded point. Either the geocode or one of the
  citations is wrong.
- **[STR20260455], The Kindred House:** "[The Kindred
  House][1694492408872771235]", 5 bedrooms, and "[Brown Bear
  Place][1195142506449964239]", 1 bedroom, from different hosts. This may be
  a suite inside the house or a second unit.

15 registration ids are cited by listings from more than one host.

## 6. Identity over time

A unit needs an id that stays the same while its records change. With one
day of data none of these is measured yet, but each follows from how the
sources work:

- **A listing adds or drops its registration id.** An "Airbnb only" unit and a
  "registry only" unit become one unit. An id taken from either record, such
  as `airbnb:<listing_id>` or `str:<registration_id>`, changes or
  collides.
- **A host deletes and recreates a listing.** The new `listing_id` belongs to
  the same unit.
- **A registration lapses and the unit registers again.** Whether a renewal
  keeps its registration id is unknown until the data spans an expiry.
- **A combo listing appears or is removed** while its component listings stay.
- **Matching rules or thresholds change**, or a new record arrives near an
  existing match, and the grouping changes.

The project's views re-derive everything from raw tables on each run. A
recomputed grouping cannot keep ids stable, so units need a persisted table
that assigns ids and records which source records belong to each unit.

## 7. Attributes when records disagree

With several records per unit, most attributes have more than one value:

- **Size:** the 700 M St [compound][720964186611110453] says 5 bedrooms and
  its component listings say 2, 2 and 1. Duplicate listings can disagree with
  each other.
- **Location:** the license's geocoded point is usually better than an Airbnb
  pin, but §5 shows cases where it is wrong.
- **Operator:** host and registration business name are different concepts
  (see [data_model.md](../../data_model.md#owners-are-not-modeled)), so both
  are kept, not coalesced.
- **Status:** a listing can be active while its registration has lapsed, and
  a registration can be active with no listing.
- **Calendar and price:** a booked compound blocks its component listings, so
  summing booked nights across listings counts one stay several times.

## 8. What each option does with these cases

**B: group by registration id, or by listing when there is none.** The
grouping is well defined, but its rows are often not units:

| Case | B produces | Probable units |
| --- | --- | --- |
| Ski Inn, [STR20261701] | 1 | 8 rooms in 1 building |
| 700 M St triplex | 1 | 3 dwellings |
| 400 Turpin St, Unit 8 | 4 | 4 rooms in 1 dwelling |
| 4011 Turnagain Blvd E, 4A | 2 | 1 |
| 4425 E 6th Ave | 9 (4 nearby listings + 5 registrations) | 1 house, 4 or 5 rooms |
| Sundi St, [STR20260765] | 1 | 2 properties |

On 2026-09-14, B would produce about 3,120 rows: 2,549 registrations plus 572
listings with no matching id. A unit's id changes when a listing adds its
registration id.

**C: entity resolution.** Cases like these can be resolved, but that requires:

1. **A unit definition.** A dwelling table with bookable spaces under it, or
   one table at a single chosen grain (§1).
2. **Persisted tables:** `units` with assigned ids, and a membership table
   (source record, unit, match method, confidence, date). Listing membership
   is many-to-many for combo listings.
3. **Matching rules in order of strength:** registration id, then
   registrations at the same normalized address and unit, then spatial
   proximity with a distance set by pin precision (§4).
4. **Address normalization** across the registry's two styles (parcel-record
   style "7730 MAYFAIR DR, Unit:APT 1" and typed text "525 w 3rd Ave #501"),
   and ideally parcel ids, which are set on 457 of 2,549 active registrations.
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

<!-- Muni CityView license pages, `registrations_current.status_url`. -->

[STR20260245]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13861&category=B
[STR20260377]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13990&category=B
[STR20260455]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14121&category=B
[STR20260765]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14390&category=B
[STR20261146]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14798&category=B
[STR20261147]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14799&category=B
[STR20261634]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15270&category=B
[STR20261701]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15340&category=B
[STR20261828]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15468&category=B
[STR20262029]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15655&category=B
[STR20262058]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15700&category=B
[STR20262059]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15701&category=B
[STR20262060]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15702&category=B
[STR20262061]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15703&category=B
[STR20262179]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15830&category=B
[STR20262180]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15831&category=B
[STR20262181]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15832&category=B
[STR20262182]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15833&category=B
[STR20262194]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15845&category=B
[STR20262195]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15846&category=B
[STR20262196]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15847&category=B
[STR20262241]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15897&category=B
[STR20262322]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15989&category=B
[STR20262388]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15746&category=B
[STR20262408]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15998&category=B
[STR20262409]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15994&category=B
[STR20262410]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15993&category=B
[STR20262564]: https://www.muni.org/CityViewPortal/License/Status?licenseId=16212&category=B
[STR20262565]: https://www.muni.org/CityViewPortal/License/Status?licenseId=16213&category=B

<!-- Airbnb listings, by listing id. -->

[645953498616566832]: https://www.airbnb.com/rooms/645953498616566832
[671779791243926274]: https://www.airbnb.com/rooms/671779791243926274
[645953306917476922]: https://www.airbnb.com/rooms/645953306917476922
[720964216940577112]: https://www.airbnb.com/rooms/720964216940577112
[656318860846776577]: https://www.airbnb.com/rooms/656318860846776577
[720964186611110453]: https://www.airbnb.com/rooms/720964186611110453
[31538594]: https://www.airbnb.com/rooms/31538594
[31236596]: https://www.airbnb.com/rooms/31236596
[31242415]: https://www.airbnb.com/rooms/31242415
[31242634]: https://www.airbnb.com/rooms/31242634
[19267486]: https://www.airbnb.com/rooms/19267486
[13381871]: https://www.airbnb.com/rooms/13381871
[13381405]: https://www.airbnb.com/rooms/13381405
[602098142436002853]: https://www.airbnb.com/rooms/602098142436002853
[598662303426408263]: https://www.airbnb.com/rooms/598662303426408263
[602107868115855878]: https://www.airbnb.com/rooms/602107868115855878
[637685143676434419]: https://www.airbnb.com/rooms/637685143676434419
[1718621980118022587]: https://www.airbnb.com/rooms/1718621980118022587
[1718609799900620065]: https://www.airbnb.com/rooms/1718609799900620065
[50156544]: https://www.airbnb.com/rooms/50156544
[51688541]: https://www.airbnb.com/rooms/51688541
[51602371]: https://www.airbnb.com/rooms/51602371
[1448272365447978936]: https://www.airbnb.com/rooms/1448272365447978936
[1236091388960535120]: https://www.airbnb.com/rooms/1236091388960535120
[1687456614565152954]: https://www.airbnb.com/rooms/1687456614565152954
[1668926817471594875]: https://www.airbnb.com/rooms/1668926817471594875
[1662003281978078076]: https://www.airbnb.com/rooms/1662003281978078076
[1447082877038361365]: https://www.airbnb.com/rooms/1447082877038361365
[50359680]: https://www.airbnb.com/rooms/50359680
[1694492408872771235]: https://www.airbnb.com/rooms/1694492408872771235
[1195142506449964239]: https://www.airbnb.com/rooms/1195142506449964239

<!-- Airbnb hosts, by host id. -->

[187849202]: https://www.airbnb.com/users/show/187849202  (the 700 M St host)
[121679638]: https://www.airbnb.com/users/show/121679638  (Evolve)
[450844916]: https://www.airbnb.com/users/show/450844916  (Shanali)
