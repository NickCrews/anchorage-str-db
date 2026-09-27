# Registration inference: suggesting a registration for a listing whose id is missing or wrong

Researched 2026-09-27 against `data/anchorage_str.duckdb`, with the
2026-09-26 run: listings from that day, registry published 2026-09-21. Every
count comes from a query in [queries.sql](queries.sql), in the order this
README uses them. Registration ids link to the Muni's license page, listing
names to Airbnb. Answers
[#39](https://github.com/NickCrews/anchorage-str-db/issues/39).

**Goal:** for a listing that prints no id, an id the registry does not hold,
or the id of a registration far away, suggest the registration it most
likely belongs to. Rules run unattended, so they must say nothing rather than
guess.

**Summary:** Four rules were validated on 1,974 listings whose printed id is
correct, by hiding the id and checking whether the rule recovers it. Together
they suggest a registration for 459 of them and get 455 right (99.1%). On the
460 listings that need a suggestion they fire far less often: the proposed
view makes **32 suggestions**, all from two rules, and a hand check found
none contradicted. Most listings without a usable id get no suggestion,
because most of them sit next to no single registration that fits. The
sibling rule the issue proposes is accurate but, once made safe, adds no
listing today.

| Rule | Confidence | Validation: suggested | Correct | Precision | Wrong suggestions when the registration is removed | Suggestions on 2026-09-26 |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | high | 161 | 158 | 98.1% | 4 | 11 |
| `exact_coordinate` | high | 242 | 242 | 100% | 13 | 21 |
| `room_sibling` | medium | 21 | 21 | 100% | 2 | 0 |
| `sibling` | medium | 104 | 103 | 99.0% | 19 | 0 (2 hits, both also `exact_coordinate`) |

---

## 1. Who needs a suggestion

2,468 active listings on 2026-09-26:

| Printed id | Listings | Exact coordinate |
| --- | --- | --- |
| Registration within 200 m | 1,974 | 663 |
| No id | 427 | 166 |
| Registration more than 1 km away | 28 | 11 |
| Not in the registry | 18 | 10 |
| Registration 200 m to 1 km away | 12 | 1 |
| Registration not geocoded | 9 | 2 |

Of the 18 ids not in the registry, 13 are higher than the newest id the
registry publishes (STR20262600). They are most likely registrations issued
after the 2026-09-21 publication, so the view waits for them rather than
suggesting something else. That leaves **460 target listings**: 427 with no
id, 28 more than 1 km from their registration and 5 with an unknown id. The
12 between 200 m and 1 km are left alone: too far for a jittered coordinate,
too close to call wrong.

**How far a correct link is.** For listings linked within 1 km, the distance
from the listing's coordinate to the registration's geocoded coordinate is:

| Coordinate | Listings | Median | 90th percentile | 95th percentile |
| --- | --- | --- | --- | --- |
| Exact | 664 | 7 m | 28 m | 40 m |
| Jittered | 1,322 | 91 m | 133 m | 141 m |

So the rules look 30 m from an exact coordinate for a lone registration, and
50 m (exact) or 200 m (jittered) for a registration with a matching name.

## 2. The rules

A **candidate** is an active registration within reach of the listing. Every
rule requires exactly one candidate that passes it; two or more is a tie and
the rule says nothing. Three safeguards recur:

- **Unclaimed:** no other active listing prints the candidate's id. A
  listing's own printed id is never evidence, which is what makes hiding it
  a fair test.
- **No unclaimed neighbour:** no other unclaimed registration is geocoded
  within 10 m of the candidate. Several registrations at one address
  (rooms, units of a duplex, a registrant filing twice) look identical from a
  coordinate, and the rules cannot tell which one a listing is.
- **Host not already there:** the host prints no registration within reach on
  another listing. Where it does, the unlinked listing may be covered by that
  registration.

The rules, in priority order:

1. **`title`**: the registrant's name (lowercase, punctuation, "LLC" and "the"
   removed, at least 6 characters) is the start of the listing's title, the
   candidate is unclaimed, within 50 m (exact) or 200 m (jittered), and has no
   unclaimed neighbour. "[Willow Street Retreat][1732144282741549349]" prints
   [STR20261641], 5.8 km away; [STR20261642], registered to "Willow Street
   Retreat", is 2 m away.
2. **`exact_coordinate`**: the coordinate is exact, exactly one active
   registration of any kind is within 30 m, and it is unclaimed with no
   unclaimed neighbour. "[The Light House at Capstan][1206127758415880403]"
   prints [STR20260204] (11271 Mountain Lake Dr, 4.7 km away) and is 2 m from
   [STR20260206], 2940 Capstan Dr, same registrant.
3. **`room_sibling`**: a Private room or Shared room listing with an exact
   coordinate, and the only registration within 30 m is one the host prints
   on another listing. Rooms of one dwelling often share a registration (see
   [rental-units](../rental-units/README.md) §2).
4. **`sibling`**: the candidate's registrant name matches a registration the
   host prints on another listing, or, for a listing whose printed
   registration is over 1 km away, that registration's registrant. It must be
   unclaimed, have no unclaimed neighbour, and the host must not already be
   there.

The view makes one suggestion per listing. If two rules suggest different
registrations, both are dropped. If one registration is suggested to several
listings, it stands only when they share a host and at most one is an Entire
home/apt: ten dormitory beds can share one hostel's registration, three
condos cannot.

**Tried and dropped** (validation, §3):

| Variant | Suggested | Correct |
| --- | --- | --- |
| Exact: one unclaimed within 30 m, even with claimed ones beside it | 414 | 400 |
| Sibling: any registration with the name, even one the host prints | 336 | 271 |
| Sibling: a registration the host does not print, no other safeguard | 557 | 519 |
| Title: a registration another listing prints is allowed | 183 | 167 |

Matching the Airbnb host's display name to a registrant name was also tried.
Only 21 hosts have a display name that equals any registrant name, some of
them first names ("Ana", "Oleg") that say nothing about which registration,
so it was not kept.

## 3. Validation

**Recovering a hidden id.** The 1,974 listings whose printed registration is
within 200 m are taken as correctly linked. Each rule runs as if the listing
printed nothing, and is scored on whether it suggests the printed
registration. The results are the table in the summary. Only 4 are wrong, and
all are the right address with the wrong unit:

- Three [Sourdough Sue's][814633890883170819] listings print [STR20260430];
  `title` suggests [STR20260429], the same registrant at the same address.
- "Peaceful Alaskan Cabin" prints [STR20262109] (6951 Hyatt St Apt A);
  `sibling` suggests [STR20262485], 6951 Hyatt St, same registrant.

**When the listing has no registration.** Recovering a hidden id measures a
listing whose registration exists. Many target listings likely have none, and
then any suggestion is wrong. To measure that, the validation runs again with
each listing's registration also deleted from the candidates:

| Rule | Wrong suggestions | At the same address as the deleted one | Same registrant |
| --- | --- | --- | --- |
| `title` | 4 | 3 | 4 |
| `exact_coordinate` | 13 | 6 | 6 |
| `room_sibling` | 2 | 2 | 1 |
| `sibling` | 19 | 18 | 19 |

Relative to how often it is right, `sibling` errs most here: 19 wrong
suggestions against 103 right ones, almost all a second registration the same
registrant holds at the same address. That is why it is medium confidence
even though it scores 99% above.

**What that means for the target listings.** `exact_coordinate` fires on
242 of 663 exact validation listings when the registration exists (37%) and
13 of 663 when it does not (2%). It fires on 27 of the 178 exact target
listings (15%), before the view's other checks. If a share *p* of those 178
have a registration in the registry, 178 × (0.365*p* + 0.020(1 − *p*)) = 27
gives *p* ≈ 0.38, and about 178 × 0.020 × 0.62 ≈ 2 of the 27 would be wrong,
roughly 92% precision. This assumes target listings sit among registrations
like validation listings do, which is untested.

**Hand check.** Every one of the view's 32 suggestions was read against the
listing's title, host and listing type and the registration's name, address
and license description (last query in §4 of queries.sql). None is
contradicted; 15 are confirmed by independent evidence:

| Verdict | Suggestions | Evidence |
| --- | --- | --- |
| Confirmed | 15 | Registrant name or registered street in the title: Willow Street Retreat, Capstan, Pyrenean Circle, [Planet Anchorage B&B][STR20261855], "[Private apartment. Located near everything!][45689608]" ([STR20261540]), Eagle River Solace Retreat, Soul Alaska, five Highland Glen Lodge rooms ([STR20261913]), and Home in Midtown with the host's two rooms in the "Midtown Duplex" |
| Consistent, not confirmed | 17 | Ten dormitory beds at [STR20261461] ("mojo Airbnb", 1069 W 25th Ave), and seven Entire home/apt or room listings 3 to 23 m from a lone registration whose name says nothing, such as "[Midnight Sun Loft][973309104095598055]" and [STR20261778] ("BR Rentals"), 23 m away, which prints [STR20261886] 3.8 km away |
| Contradicted | 0 | |

The dropped hits read the same way. Three Evolve condos ([1][51902855],
[2][675919597906848951], [3][1650797199392143518]) are each within 30 m of
[STR20262416], 315 E St, and nothing else. At most one of them can be that
registration, so the view suggests it to none.

**Cases the rules decline, correctly:**

- **The issue's example, [STR20260765].** "[Eagle nest home][1668926817471594875]"
  and "[Eagle Suite][1662003281978078076]" print the Sundi St id from 29 km
  away. 10120 Caribou St, 73 m and 98 m from them, holds two "Northern Stay"
  registrations: [STR20260465], which the host's "Eagle Nest Apt" prints, and
  [STR20261104], which no listing prints. Two listings, one free
  registration, and a host already there: `sibling` declines. One of them is
  probably STR20261104, but not which.
- **Shaligo, [STR20262410].** Listing [1272688442355424229] prints room 4 at
  4425 E 6th Ave, but its exact coordinate is 3 m from 3503 E 16th Ave, where
  Shaligo AK Stays holds 10 registrations ([STR20262240] and rooms 2 to 10),
  6 of them unclaimed. The printed id is 1.5 km away, so the listing is a
  target, and every rule declines: too many registrations at one address.

## 4. Proposed view

`listing_registration_suggestions`, one row per target listing with a
suggestion:

| Column | Meaning |
| --- | --- |
| `listing_id` | the listing |
| `registration_id` | the suggested registration |
| `rule` | the highest-priority rule that suggested it |
| `confidence` | `high` for `title` and `exact_coordinate`, `medium` otherwise |
| `distance_m` | from the listing's coordinate to the registration's geocoded coordinate |
| `rules` | every rule that suggested it |

Its SQL is in [queries.sql](queries.sql): `ri_rule_hits` holds the rules and
`listing_registration_suggestions` the selection. Both are written against
temp tables (`ri_*`) so the validation can switch off the listing's printed
registration and its registrant name; as a real view they fold into one CTE
chain over `listings_active_with_host` and `registrations_active`.

On 2026-09-26:

| Target | Rule | Confidence | Listings |
| --- | --- | --- | --- |
| No id | `exact_coordinate` | high | 18 |
| No id | `title` | high | 8 |
| Over 1 km | `exact_coordinate` | high | 3 |
| Over 1 km | `title` | high | 3 |

That is 32 of 460 target listings. The 6 over-1-km suggestions correct a
printed id; 5 of them are cases
[registration-location-mismatch](../registration-location-mismatch/README.md)
had already called "likely the wrong id".

## 5. Running it unattended

- A suggestion never overwrites `registration_id`. It sits in its own view,
  carries its rule and distance, and is recomputed every run from the
  observations, so a wrong one disappears when the data changes and nothing
  has to be undone.
- Consumers should use `high` by default. `medium` rules are validated but
  err more often when a listing has no registration at all.
- Every rule prefers silence: a tie, a shared address or a host already on the
  spot means no suggestion.
- No AI step is proposed. If one is added later, it should only choose among
  the candidates these rules already list, one listing at a time, with its
  choice logged next to the rule output.

## Proposed vocabulary

The maintainer proposed two words for [CONTEXT.md](../../../CONTEXT.md),
used above only in §2 and §3: a **dwelling** is a home or apartment that could
be a long-term rental, and a **room** is a strict subset of a dwelling.
CONTEXT.md currently lists both under _Avoid_ for **unit**, so they need to
be added there before code uses them.

## Limits

- Validation listings are ones whose hosts printed a correct id, and most
  sit next to their registration. Target listings may differ in ways the
  removal test does not capture.
- The geocoder can misplace a registered address, and a host can misplace a
  listing's coordinate. Both make a rule decline, or, rarely, suggest a
  neighbour.
- `unclaimed` uses today's printed ids. When a listing starts printing the id
  a rule suggested to another listing, that suggestion drops out, which is
  the intended behaviour.
- One day of data. Whether suggestions are stable run to run is untested.

<!-- Muni CityView license pages, `registrations_active.status_url`. -->

[STR20260204]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13786&category=B
[STR20260206]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13788&category=B
[STR20260429]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14092&category=B
[STR20260430]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14093&category=B
[STR20260465]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14044&category=B
[STR20260765]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14390&category=B
[STR20261104]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14757&category=B
[STR20261461]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15032&category=B
[STR20261540]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15177&category=B
[STR20261641]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15278&category=B
[STR20261642]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15279&category=B
[STR20261778]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15417&category=B
[STR20261855]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15496&category=B
[STR20261886]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15542&category=B
[STR20261913]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15568&category=B
[STR20262109]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15757&category=B
[STR20262240]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15896&category=B
[STR20262410]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15993&category=B
[STR20262416]: https://www.muni.org/CityViewPortal/License/Status?licenseId=16064&category=B
[STR20262485]: https://www.muni.org/CityViewPortal/License/Status?licenseId=16090&category=B

<!-- Airbnb listings, by listing id. -->

[1732144282741549349]: https://www.airbnb.com/rooms/1732144282741549349
[1206127758415880403]: https://www.airbnb.com/rooms/1206127758415880403
[45689608]: https://www.airbnb.com/rooms/45689608
[814633890883170819]: https://www.airbnb.com/rooms/814633890883170819
[973309104095598055]: https://www.airbnb.com/rooms/973309104095598055
[51902855]: https://www.airbnb.com/rooms/51902855
[675919597906848951]: https://www.airbnb.com/rooms/675919597906848951
[1650797199392143518]: https://www.airbnb.com/rooms/1650797199392143518
[1668926817471594875]: https://www.airbnb.com/rooms/1668926817471594875
[1662003281978078076]: https://www.airbnb.com/rooms/1662003281978078076
[1272688442355424229]: https://www.airbnb.com/rooms/1272688442355424229
