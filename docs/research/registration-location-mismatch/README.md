# Listings at a different location than their registration

Researched 2026-09-14. Some Airbnb listings show a Muni STR registration id
that is registered to an address far from the listing. This folder finds them
and builds [report.html](report.html), a self-contained report for the
Municipal Clerk's Office.

**Summary:** On 2026-09-14, 30 Airbnb listings showed a registration id
registered 1.0 km to 45.6 km from the listing, across 21 different ids.
Airbnb blurs map locations by up to about 200 m, so these are too far apart to
be the same place.

## Three kinds of problem

| Problem | Listings | What it means | Suggested fix |
| --- | --- | --- | --- |
| Likely the wrong id | 15 | A different registration right next to the listing has a matching name. The host probably copied the id from another of their rentals. | Ask the host to fix the listing, to have the matching nearby registration's id. If that registration is for a different unit, this rental needs its own registration. |
| One id, two places | 10 | Other listings with the same id are at the registered address, and this one is not. One registration may be covering a second rental. | Ask the host to register the second rental and show that new id on its listing. |
| Not at the registered address | 5 | No listing with the id is near the registered address, and nothing nearby matches. The registration may have the wrong address. | Ask the registrant where the rental is. If the registered address is wrong, correct the registration. If the listing is a different rental, it needs its own registration. |

### Likely the wrong id

"Willow Street Retreat" shows STR20261641, which is registered to "Home away
from home" at 6605 Stella Pl, 5.8 km away. 2 m from the listing is
STR20261642, registered to "Willow Street Retreat" at 3008 Willow St. The
listing probably should show STR20261642.

Other cases in this group:

- **STR20260765** is registered to "Joe Dudley" at 8483 Sundi St. All four
  listings showing it belong to the Airbnb host "Northern Stay". Two are at
  Sundi St. The other two are 29 km away in Eagle River, 98 m from two
  registrations whose business name is "Northern Stay".
- **STR20260204** ("Vacation Rentals In Alaska", 11271 Mountain Lake Dr) is
  shown by "The Light House at Capstan" and "Relax Like Never Before at
  Pyrenean Circle". Those listings are 2 m and 4 m from STR20260206 (2940
  Capstan Dr) and STR20260207 (3907 Pyrenean Cir), which have the same
  business name and no listing of their own.

### One id, two places

STR20262172 is registered to "Crawford Abodes" at 4743 E Northern Lights Blvd.
Six Airbnb listings show it. Five are at that address, and "Borealis priv rm-
nestled under Chugach mountains" is 3.9 km away.

### Not at the registered address

STR20260610 is registered at 3705 Arctic Blvd #108, with the business name
"1327 Medfra Street". The only listing showing it, "Sunny Spot in Fairview", is
3.4 km away. The same registrant's
STR20260609 has the same registered address.

## Files

| File | What it is |
| --- | --- |
| [cases.sql](cases.sql) | One row per listing more than 500 m from its registration, with the other listings on its id and the registrations near it. |
| [distances.sql](distances.sql) | Distance counts for every linked listing, quoted in the report's method section. |
| [build.mjs](build.mjs) | Runs both queries, sorts each case into one of the three problems, and writes `report.html` from `template.html`. |
| [template.html](template.html) | The report page. `__REPORT_DATA__` is replaced with the cases as JSON. The example for each problem is chosen in `EXAMPLES`. |
| [report.html](report.html) | The built report. |

Rebuild from the repo root (needs the `duckdb` CLI):

```sh
node docs/research/registration-location-mismatch/build.mjs
```

The report loads Leaflet from cdnjs and map tiles from Esri, so its map needs
an internet connection. The table and case text work without one.

## What the Muni requires

From the Municipal Clerk's
[Short Term Rental Registration Program](https://www.muni.org/Departments/Assembly/Clerk/Licensing/Pages/Short-Term-Rental-Registration-Program.aspx)
page, read 2026-09-14:

> Beginning July 31, 2026, all short-term rentals operating in the
> Municipality are required to display their STR Registration Number on all
> listings and advertisements, regardless of platform.

> The STR Registration Form requirements are established in Anchorage
> Municipal Code 10.90.020 per AO 2025-115(S-2) as follows: The street address
> of the STR; The type of living unit (i.e. a bedroom, house, townhouse,
> duplex, or condo) …

The application asks for a business name and description "For Each Rental
Unit", and "If multiple rental units are located within one address, please
note identifying information such as: Bedroom 1, Bedroom 2, Upstairs Unit".

The same page says violations are reported to the Code Enforcement Hotline
(907-343-4141) or through ANCWorks, and registration questions go to
MuniLicenses@anchorageak.gov (907-343-4311).

## Method

**Distance.** For each active listing whose id is in the latest
registry, the distance from Airbnb's pin to the registration's geocoded point
(2026-09-14):

| Distance | Listings |
| --- | --- |
| 200 m or less | 1,993 |
| 200 m to 500 m | 15 |
| 500 m to 1 km | 0 |
| More than 1 km | 30 |
| Total | 2,038 |

Airbnb offsets approximate pins, and the median approximate pin is 92 m from
its registration (see [rental-units](../rental-units/README.md#4-linking-listings-to-registrations)).
Nothing falls between 500 m and 1 km, so a 500 m cutoff separates Airbnb's
offset from a different location. The 15 listings between 200 m and 500 m are
not in the report. 9 listings cite a registration the geocoder could not place
and are not compared.

**Sorting into problems.** `build.mjs` gives each listing the first of these
that applies:

1. **Likely the wrong id:** a different active registration within 200 m
   of the pin has a business name that matches the displayed registration's
   business name, the Airbnb host's name, or the start of the listing title.
   Names are compared ignoring case, punctuation and "LLC". A street named in
   the title, or an id one digit off from the displayed one (only when there
   is a single match), is noted as extra evidence but is not enough by itself:
   other registrations on the same street, and operators' consecutive ids,
   are common.
2. **One id, two places:** another listing on the same id is within
   500 m of the registered address.
3. **Not at the registered address:** neither of the above.

| Problem | Registrations |
| --- | --- |
| Likely the wrong id | STR20260204, STR20260609, STR20260765, STR20261029, STR20261034, STR20261162, STR20261520, STR20261530, STR20261641, STR20261938, STR20262127 |
| One id, two places | STR20260455, STR20261520, STR20261619, STR20261754, STR20262172, STR20262388 |
| Not at the registered address | STR20260098, STR20260610, STR20261361, STR20261677, STR20261886 |

STR20261520 appears twice: one of its listings has no name match nearby.

## Limits

- A host can misplace an Airbnb pin, and the Muni geocoder can misplace a
  typed address. The report shows the registered and geocoded addresses for
  each case.
- A name match is a lead, not a confirmation. For a property manager with
  many registrations at one complex, such as Arctic Fox Vacation Rentals
  (13 matches), it shows the listing belongs there but not which dwelling.
- Listings with no id, or an id not in the registry, are out of scope.
- Data is from one day: listings 2026-09-14, registry published 2026-09-07.
