# Combo listings: which listings cover other listings

Researched 2026-09-27 against `data/anchorage_str.duckdb`, latest run
2026-09-26. Every count and example comes from a query in
[queries.sql](queries.sql). Registration ids link to the Muni's license page,
listing names to Airbnb. Answers
[#38](https://github.com/NickCrews/anchorage-str-db/issues/38).

**Goal:** find the listings that combine other listings, link each to the
listings it covers, and say how reliable the link is.

**Summary:** The calendars can tell a combo from its components when a
component has a not-available run with a start and an end inside the window,
and the combo repeats it exactly. A rule built on that, same host and a
registration id or name that backs it up, links 49 pairs. By hand, 43 are
right, 0 are wrong and 6 cannot be decided from what we store. They make 28
combo listings and 45 component listings, 70 listings in all, 2.8% of the
2,468 active listings. The rule misses combos whose components have nothing
on their calendar to test, such as the 1-bedroom unit of the 700 M St
triplex. It is good enough for a view that marks combos. It is not good
enough to say that every other listing is atomic.

---

## Words

These are the terms the issue proposes. They are not yet in
[CONTEXT.md](../../../CONTEXT.md), and two of them, dwelling and room, are on
the _Avoid_ list of **Unit** there, so adopting them means settling that
first.

- **Dwelling:** a home or apartment that could be a long-term rental.
- **Room:** part of a dwelling rented on its own.
- **Combo listing:** a listing that covers two or more other listings. It can
  itself be part of a larger combo.
- **Component listing:** a listing a combo listing covers.
- **Atomic listing:** a listing that covers no other listing. It covers
  exactly one dwelling or one room.

This doc also uses two words for the calendar:

- **Run:** consecutive not-available nights on one listing's calendar. An
  **interior run** starts after the first night we hold and ends before the
  last, so both of its edges are observed.
- **Violation:** a night the component is not available and the combo is
  available. Whatever makes a component not available, a stay or the host,
  makes its combo not available too, so a true pair has none.

## 1. The 700 M St triplex

**[STR20261828], [one host][187849202]:**

| Listing | Bedrooms | First run ends | Interior runs |
| --- | --- | --- | --- |
| [Bootlegger's Bungalow][645953498616566832] | 2 | 2027-04-29 | 2027-07-26 to 07-29 |
| [Sleeping Lady Retreat][671779791243926274] | 2 | 2027-04-29 | 2027-06-02 to 06-03 |
| [Captain Cook's Condo][645953306917476922] | 1 | 2027-05-15 | none |
| [M Street 3BR Combo][656318860846776577] | 3 | 2027-05-15 | 2027-07-26 to 07-29 |
| [M Street Triplex, Full 5BR Compound][720964186611110453] | 5 | 2027-05-15 | 2027-06-02 to 06-03, 2027-07-26 to 07-29 |

All five are not available from the first night until late April or mid May.
That stretch says nothing about which listing covers which. The two short
runs do:

- The Bungalow's 4 nights in July show up, with the same edges, on the 3BR
  Combo and on the compound.
- Sleeping Lady's 2 nights in June show up on the compound, and not on the
  3BR Combo, which is available on both nights. That is 2 violations.

So the compound covers the Bungalow, Sleeping Lady and the 3BR Combo, and the
3BR Combo covers the Bungalow but not Sleeping Lady. By bedrooms, the 3BR
Combo is the Bungalow plus Captain Cook's Condo, and the compound is all
three dwellings. But Captain Cook has no interior run, so its calendar cannot
confirm that. The rule links 4 of the 6 pairs the bedrooms imply and misses
the two with Captain Cook.

[Bootleggers Landing Villa][720964216940577112] shows the same registration
id, is 377 m from the compound's pin and has 1 not-available night. Nothing
links it to the others.

## 2. What each signal is worth

Every active listing has a calendar of 340 nights, 2026-09-26 to 2027-08-31,
and 31% of those nights are not available. Candidate pairs are any two
active listings within 500 m of each other or showing the same registration
id, where the first has more bedrooms (a studio is 0, a room listing with no
count is 1).

- **Host.** 1,187 candidate pairs share a host and 23,209 do not. The
  calendar rule below links 66 of the first and 19 of the second, 5.6%
  against 0.08%. Pairs across hosts are almost never combos, so this rule
  requires one host.
- **Calendars, overlap.** Counting shared not-available nights does not work.
  Many listings are not available for months at the start of the window, as
  at M St, and any two such calendars overlap. Of the 456 same-host pairs
  with at most 2 violations, 305 have a component with no interior run at
  all.
- **Calendars, matched runs.** An interior run of the component that the
  combo repeats exactly: not available on every night of the run, available
  the night before and the night after. One matched run is weak alone, since
  two listings are often not available on the same weekend. Two or more are
  rare by chance.
- **Registration id.** Of the 28 combos found, 19 show an id one of their
  components also shows. Sharing an id is common among a host's listings at
  one address, so it backs up a calendar link but does not make one.
- **Bedrooms.** A combo must have more bedrooms than each component. The
  sum is a check, not a test: in 10 of the 25 combos that are not part of a
  larger one, the atomic listings found add up to the combo's bedrooms (§4).
  Where they fall short, as at M St, a component is often missing. Guest
  capacity is not used.
- **Name.** "Combo", "Compound", "Full Duplex", "Whole house", "2-Unit",
  "2 Adjoining Condos", "2 houses in 1", "Double house". The name only
  promotes a pair the calendars already link.

## 3. The rule and its precision

A pair (combo, component) is accepted when:

1. **Linked:** same host; same registration id or pins within 500 m; the
   combo has more bedrooms; at most 2 violations; at least 1 matched run.
2. **Strong:** 2 or more matched runs, or the same registration id, or a
   combo name that says it combines units.
3. **Not a sibling:** the component is not also a strong component of a
   listing with more bedrooms, unless this combo's name says combo. Two
   dwellings inside one combo share every run the combo puts on both, so the
   bigger one can look like it covers the smaller. The Monarch Estate's
   upper level seemed to cover its lower level this way.

I checked all 66 linked pairs by hand from their names, bedrooms,
registration ids, distance and calendars. I did not open the listing pages.

| Step | Pairs | Right | Wrong | Cannot tell |
| --- | --- | --- | --- | --- |
| Linked, not strong | 13 | 0 | 7 | 6 |
| Strong, sibling | 4 | 0 | 3 | 1 |
| **Accepted** | **49** | **43** | **0** | **6** |

Precision of the accepted pairs is 43 of 43 decided, and 43 of 49 (88%) if
every undecided pair is wrong. The sibling step was written after seeing
these cases, so this sample overstates it; it needs checking on a later run.

Accepted combos, beyond M St:

| Combo | Components found | Evidence |
| --- | --- | --- |
| [The Jules Whole House][3457665], [STR20262385] | [Top Suite][13416604], [Room North][13416897], [Room South][13416993] | 2 matched runs each; the combo holds its own registration |
| [Goldenview Retreat][48492935], [STR20261470] | 3 suites ([Arctic King][48531882], [Aerie][48532605], [Eagles Nest][48532925]) | same id; 1 to 4 matched runs |
| [AK Village, 4 unit combo][919861119846421474], [STR20261907] | [Alaskan Double house][671080169206801340] and [Denali Double House, 3BR combo][919850596440235634], and the studios and 2-bedroom inside them | nested combos; 1 or 2 matched runs each |
| [Alyeska 2-Unit Chalet][53574551], [STR20261245] | [Drift to the Lift][53560259] (3), [Walk Anywhere][53573226] (2) | 3 and 5 matched runs; 3 + 2 = 5 bedrooms |
| [Downtown Airbnb (Full Duplex)][710295528067536426], [STR20262081] | [Unit A][710280902480078850], [Unit B][710134390747537081] | name; 2 + 2 = 4 bedrooms; three registrations for one duplex |
| [The Retreat at Moose Meadows][817510656719871504], [STR20260391] | [Mountain Chalet][815508132639490169] (4), [Hideaway][43819678] (2) | 8 and 6 matched runs |
| [Hygge House (2 houses in 1!)][832278111770365732], [STR20262330] | [Bel-Hygge Chalet][52962848], [Hygge Hideaway][643585266500303881] | 3 and 6 matched runs; own registration |
| [The Monarch Estate][1197715784748015844], [STR20261884] | [Upper Level][1206608250708549650], [Lower Level][1206608243376149637] | same id; 3 matched runs each |
| [Anchorage Grand Home Downtown Villa][1373566734504523791], [STR20261322] | [Grand Four Bedroom][608445027482501945], [Elegant 2BR Suite][33803798] | 7 and 5 matched runs; 4 + 2 = 6 bedrooms |
| [Spacious Duplex for 16+][1506589954006831604], [STR20260015] | [Serene Townhome][1506670448455178934] (3), [Modern 2BR Townhome][1506656780831589146] (2) | 3 and 2 matched runs; own registration |
| [Entire Duplex! Downtown 4 Bdr][1627750104313503229], [STR20261766] | [WestChester Casa][843453113073260077], [South Addition Getaway][1577709087926261623] | 4 and 2 matched runs; own registration |
| [Dtwn Anchorage Getaway: 2 Adjoining Condos][1650797199392143518] | [Modern Downtown Apt][51902855], [Idyllic Dtwn Condo][675919597906848951] | 5 and 4 matched runs; neither shows an id |
| [Central Home w/hot tub][781561466237821991], [STR20260347] | [Cozy Arctic Den][558100013878090934] | 8 matched runs |
| [Charming Cabin Duplex][1671759924941130693], [STR20260275] | [Garmisch Ski Cabin, Raven][1614545221246831723] | 12 matched runs |

The 10 wrong pairs are numbered units of one lot or building ("#1 Pendleton
Cottage" and "#4 Slumber Village", Lark St apartments, Arbor du Nord 1B and
1A), two ski condos under one property manager, and the three siblings. The
strong step removes the first 7, which each have 1 matched run and no shared
id.

The 6 undecided accepted pairs:

- the Mountainside Estate at 6 and 5 bedrooms, one id, one calendar: a combo
  or one house listed twice;
- two pairs among three Chugiak chalets whose sizes do not add up;
- a Moose Meadow 3-bedroom and a 1-bedroom on one id;
- a lakeside house and a studio with one matched run between them;
- two private-room listings, 6 and 3 bedrooms, with one calendar.

## 4. How many

- **49 pairs, 28 combo listings, 45 component listings.** 3 listings are
  both: the M St 3BR Combo, the Alaskan Double house and the Denali Double
  House. 70 listings are involved, from 23 hosts.
- **Atomic listings covered.** 25 combos are not part of a larger one. Of
  those, 11 cover 1 atomic listing we found, 11 cover 2 and 3 cover 3. The
  atomic listings' bedrooms add up to the combo's in 10.
- **Nights.** The 28 combos hold 3,024 of the 260,503 not-available nights
  across all active listings, 1.2%. A count at the grain of listings adds
  those on top of their components' nights.
- **Registrations.** 6 combos show a registration id none of their
  components shows: [STR20260015], [STR20260605], [STR20261766],
  [STR20262081], [STR20262330] and [STR20262385]. Each is a registration for
  a space the component registrations already cover. 19 share an id with a
  component and 3 show none.

## 5. What it misses

The rule needs a component with an interior run. 20 active listings match
the name pattern of §2. 19 of them have a same-host candidate, and the rule
found components for 14. The other 5:

- [Penguin Ridge Estate, Full 4BR Duplex Compound][1493037319494937946]: its
  two duplex halves have interior runs, and the estate is not available on
  all of them, but on none with the same edges.
- [Raven Moon, 2 Entire Apts][34092705], [3 Units, Luxury Retreat][1224661897075721897]
  and [Entire Building, 6 Bedrooms][1737170677175033714]: their candidate
  components have no interior run, or only one, to test.
- [St Moritz Compound][25818928] may be one house with a grand name.

So the precision above is for the pairs found. Recall is unknown and
probably well below it: every listing the rule does not mark as a combo is
only presumed atomic.

Two things would raise recall without changing the rule:

- **More history.** The calendar history starts on 2026-09-24. A run that
  appears on the combo and the component on the same run date, when both were
  available the day before, is the strongest evidence there is. Three days
  hold too few of these to use.
- **The listing text.** A combo's description may name the units it
  includes. We store the name and title but not the description.

## 6. Proposed view

Reliable enough for a view that marks combos and their components, as long
as its docs say that recall is partial. The SQL below is the accepted step
of §3. `queries.sql` §6 runs it and checks that it gives the same 49 pairs.

```sql
CREATE OR REPLACE VIEW listing_components AS
WITH window_nights AS (
    SELECT listing_id, night_date, NOT available AS not_available, (listing_id, night_date) AS listing_night
    FROM calendar_current
    WHERE night_date >= (SELECT scrape_date FROM latest_scrape_date)
      AND listing_id IN (SELECT listing_id FROM listings_active)
),
runs AS (
    -- Interior not-available runs: both edges inside the window.
    SELECT listing_id, min(night_date) AS run_start, max(night_date) AS run_end
    FROM (
        SELECT *, sum(changed) OVER (PARTITION BY listing_id ORDER BY night_date) AS run_no
        FROM (
            SELECT *, (not_available IS DISTINCT FROM lag(not_available)
                OVER (PARTITION BY listing_id ORDER BY night_date))::int AS changed
            FROM window_nights
        )
    )
    WHERE not_available
    GROUP BY listing_id, run_no
    HAVING min(night_date) > (SELECT min(night_date) FROM window_nights)
       AND max(night_date) < (SELECT max(night_date) FROM window_nights)
),
sized AS (
    SELECT
        listing_id, host_id, name, registration_id, location_lat, location_lng,
        coalesce(CASE WHEN bedrooms = 'Studio' THEN 0
                      ELSE try_cast(split_part(bedrooms, ' ', 1) AS int) END, 1) AS bedrooms_n
    FROM listings_active
),
pairs AS (
    -- Same host, bigger combo, same registration id or within 500 m.
    SELECT *
    FROM (
        SELECT
            c.listing_id AS combo_listing_id,
            k.listing_id AS component_listing_id,
            coalesce(c.registration_id = k.registration_id, false) AS same_registration,
            2 * 6371000 * asin(sqrt(
                pow(sin(radians(k.location_lat - c.location_lat) / 2), 2)
                + cos(radians(c.location_lat)) * cos(radians(k.location_lat))
                  * pow(sin(radians(k.location_lng - c.location_lng) / 2), 2)
            )) AS meters,
            c.bedrooms_n AS combo_bedrooms,
            k.bedrooms_n AS component_bedrooms,
            regexp_matches(c.name, '(?i)\bcombo\b|compound|full (duplex|house|building|home)|entire (duplex|building)|entire apts|whole house|both units|\d+[ -]units?\b|two units|adjoining|houses in 1|double house') AS combo_name_says_combo
        FROM sized c
        JOIN sized k ON k.host_id = c.host_id
                    AND k.listing_id <> c.listing_id
                    AND c.bedrooms_n > k.bedrooms_n
    )
    WHERE same_registration OR meters <= 500
),
violations AS (
    SELECT p.combo_listing_id, p.component_listing_id,
           count(*) FILTER (WHERE k.not_available AND NOT c.not_available) AS violations
    FROM pairs p
    JOIN window_nights k ON k.listing_id = p.component_listing_id
    JOIN window_nights c ON c.listing_night = (p.combo_listing_id, k.night_date)
    GROUP BY ALL
),
matched AS (
    -- Component runs the combo repeats exactly: not available throughout,
    -- available the night before and the night after.
    SELECT combo_listing_id, component_listing_id, count(*) AS matched_runs
    FROM (
        SELECT p.combo_listing_id, p.component_listing_id, r.run_start
        FROM pairs p
        JOIN (
            SELECT *, unnest(generate_series(run_start - 1, run_end + 1, INTERVAL 1 DAY))::date AS night_date
            FROM runs
        ) r ON r.listing_id = p.component_listing_id
        JOIN window_nights n ON n.listing_night = (p.combo_listing_id, r.night_date)
        GROUP BY ALL
        HAVING count(*) = r.run_end - r.run_start + 3
           AND bool_and(n.not_available = (n.night_date BETWEEN r.run_start AND r.run_end))
    )
    GROUP BY ALL
),
strong AS (
    SELECT p.*, v.violations, m.matched_runs
    FROM pairs p
    JOIN violations v USING (combo_listing_id, component_listing_id)
    JOIN matched m USING (combo_listing_id, component_listing_id)
    WHERE v.violations <= 2
      AND (m.matched_runs >= 2 OR p.same_registration OR p.combo_name_says_combo)
)
-- Drop siblings: a pair whose component has a bigger strong combo, unless
-- this combo's name says it combines units.
SELECT * EXCLUDE (biggest_combo_bedrooms)
FROM (
    SELECT *, max(combo_bedrooms) OVER (PARTITION BY component_listing_id) AS biggest_combo_bedrooms
    FROM strong
)
WHERE combo_name_says_combo OR combo_bedrooms = biggest_combo_bedrooms;
```

The joins go through the `listing_night` struct because DuckDB otherwise
joins the two calendars on the night first, which took minutes. Written this
way the view runs in under a second.

The derived metric, atomic listings each active listing covers:

```sql
WITH combos AS (
    SELECT
        combo_listing_id,
        count(*) FILTER (
            WHERE component_listing_id NOT IN (SELECT combo_listing_id FROM listing_components)
        ) AS atomic_listings
    FROM listing_components
    GROUP BY 1
)
SELECT
    l.listing_id,
    CASE WHEN c.combo_listing_id IS NULL THEN 'atomic' ELSE 'combo' END AS listing_role,
    coalesce(c.atomic_listings, 1) AS atomic_listings_covered
FROM listings_active l
LEFT JOIN combos c ON c.combo_listing_id = l.listing_id;
```

On 2026-09-26 this gives 2,440 listings as atomic and 28 as combos. "Atomic"
here means not found to be a combo (§5).

## Open questions

- Settle dwelling and room in CONTEXT.md against **Unit**, which lists both
  under _Avoid_.
- Should the view keep only the latest calendar, or accumulate pairs across
  runs? A pair seen once stays true while both listings are active, and
  history will add matched runs that later calendars have dropped.
- The undecided pairs need someone to open the listing pages. So does a
  sample of listings the rule calls atomic, to measure recall.

<!-- Muni CityView license pages, `registrations.status_url`. -->

[STR20260015]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13622&category=B
[STR20260275]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13891&category=B
[STR20260347]: https://www.muni.org/CityViewPortal/License/Status?licenseId=13961&category=B
[STR20260391]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14024&category=B
[STR20260605]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14230&category=B
[STR20261245]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14873&category=B
[STR20261322]: https://www.muni.org/CityViewPortal/License/Status?licenseId=14918&category=B
[STR20261470]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15103&category=B
[STR20261766]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15353&category=B
[STR20261828]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15468&category=B
[STR20261884]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15526&category=B
[STR20261907]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15549&category=B
[STR20262081]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15724&category=B
[STR20262330]: https://www.muni.org/CityViewPortal/License/Status?licenseId=15981&category=B
[STR20262385]: https://www.muni.org/CityViewPortal/License/Status?licenseId=16039&category=B

<!-- Airbnb listings, by listing id. -->

[645953498616566832]: https://www.airbnb.com/rooms/645953498616566832
[671779791243926274]: https://www.airbnb.com/rooms/671779791243926274
[645953306917476922]: https://www.airbnb.com/rooms/645953306917476922
[656318860846776577]: https://www.airbnb.com/rooms/656318860846776577
[720964186611110453]: https://www.airbnb.com/rooms/720964186611110453
[720964216940577112]: https://www.airbnb.com/rooms/720964216940577112
[3457665]: https://www.airbnb.com/rooms/3457665
[13416604]: https://www.airbnb.com/rooms/13416604
[13416897]: https://www.airbnb.com/rooms/13416897
[13416993]: https://www.airbnb.com/rooms/13416993
[48492935]: https://www.airbnb.com/rooms/48492935
[48531882]: https://www.airbnb.com/rooms/48531882
[48532605]: https://www.airbnb.com/rooms/48532605
[48532925]: https://www.airbnb.com/rooms/48532925
[919861119846421474]: https://www.airbnb.com/rooms/919861119846421474
[671080169206801340]: https://www.airbnb.com/rooms/671080169206801340
[919850596440235634]: https://www.airbnb.com/rooms/919850596440235634
[53574551]: https://www.airbnb.com/rooms/53574551
[53560259]: https://www.airbnb.com/rooms/53560259
[53573226]: https://www.airbnb.com/rooms/53573226
[710295528067536426]: https://www.airbnb.com/rooms/710295528067536426
[710280902480078850]: https://www.airbnb.com/rooms/710280902480078850
[710134390747537081]: https://www.airbnb.com/rooms/710134390747537081
[817510656719871504]: https://www.airbnb.com/rooms/817510656719871504
[815508132639490169]: https://www.airbnb.com/rooms/815508132639490169
[43819678]: https://www.airbnb.com/rooms/43819678
[832278111770365732]: https://www.airbnb.com/rooms/832278111770365732
[52962848]: https://www.airbnb.com/rooms/52962848
[643585266500303881]: https://www.airbnb.com/rooms/643585266500303881
[1197715784748015844]: https://www.airbnb.com/rooms/1197715784748015844
[1206608250708549650]: https://www.airbnb.com/rooms/1206608250708549650
[1206608243376149637]: https://www.airbnb.com/rooms/1206608243376149637
[1373566734504523791]: https://www.airbnb.com/rooms/1373566734504523791
[608445027482501945]: https://www.airbnb.com/rooms/608445027482501945
[33803798]: https://www.airbnb.com/rooms/33803798
[1506589954006831604]: https://www.airbnb.com/rooms/1506589954006831604
[1506670448455178934]: https://www.airbnb.com/rooms/1506670448455178934
[1506656780831589146]: https://www.airbnb.com/rooms/1506656780831589146
[1627750104313503229]: https://www.airbnb.com/rooms/1627750104313503229
[843453113073260077]: https://www.airbnb.com/rooms/843453113073260077
[1577709087926261623]: https://www.airbnb.com/rooms/1577709087926261623
[1650797199392143518]: https://www.airbnb.com/rooms/1650797199392143518
[51902855]: https://www.airbnb.com/rooms/51902855
[675919597906848951]: https://www.airbnb.com/rooms/675919597906848951
[781561466237821991]: https://www.airbnb.com/rooms/781561466237821991
[558100013878090934]: https://www.airbnb.com/rooms/558100013878090934
[1671759924941130693]: https://www.airbnb.com/rooms/1671759924941130693
[1614545221246831723]: https://www.airbnb.com/rooms/1614545221246831723
[1493037319494937946]: https://www.airbnb.com/rooms/1493037319494937946
[34092705]: https://www.airbnb.com/rooms/34092705
[1224661897075721897]: https://www.airbnb.com/rooms/1224661897075721897
[1737170677175033714]: https://www.airbnb.com/rooms/1737170677175033714
[25818928]: https://www.airbnb.com/rooms/25818928

<!-- Airbnb hosts, by host id. -->

[187849202]: https://www.airbnb.com/users/show/187849202
