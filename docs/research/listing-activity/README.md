# Listing activity: what "active" should mean, and at what grain

As of the 2026-11-27 Airbnb run, with 36 runs on record from 2026-09-24.
Every count comes from a query in [queries.sql](queries.sql), run after the
viewer's estimate tables are built. Answers
[#85](https://github.com/NickCrews/anchorage-str-db/issues/85).

**Goal:** find the listings that are on Airbnb but whose dwelling or room is
not operating, and settle the vocabulary and grain for activity so that
question can be asked cleanly.

**Summary:** The current words mix three different things: whether a
listing is in Airbnb's search, whether its calendar is offered and booked,
and whether a dwelling is operating as an STR. "Active" names the first for
listings, a Muni status for registrations, and something else for licenses,
and outside this repo "active listing" usually means the second. The data
shows the first is not a lifecycle: 98 of the 521 listings that left search
came back, and on 2026-10-01 Airbnb dropped 257 listings at once, 94% of them
showing no registration id. The proposal is three layers, each at its own
grain: **in search** (listing × run), **offered / rented** (listing ×
night, rolled up to listing × month and × 365 nights), and **operating**
(dwelling or room × period). "Active" stays only on Muni records, where it is
the Muni's word. **Dormant** is then a 365-night listing classification next
to FREH: in search, nothing rented. Over two months of autumn data, 201
listings are unbooked and 342 are closed for the season; neither is proof of
dormancy yet.

---

## 1. What the current words conflate

| Word now | Record | Test now | What it actually measures |
| --- | --- | --- | --- |
| active / inactive, retire | listing | seen in search within 5 days of the latest run | presence in Airbnb's undated search |
| active / lapsed | registration | STR Certificate status `Active` | the Muni's permission |
| active (`licenses.is_active`) | license | latest issuance `Active` or `Issued` | the Muni's permission, a different test |
| operating | dwelling or room | not estimated | the world: rented for stays under 30 nights |

Four problems:

1. **One word, three tests.** `listings_active_with_registration` carries
   `is_active` and `registration_is_active` side by side with unrelated
   meanings.
2. **Outside readers read "active" as activity.** In STR research and data
   products an active listing is usually one that was available or booked in
   the period, or reviewed in the last year. "2,249 active listings" is read
   as 2,249 rentals in use, which is the conflation #85 is about.
3. **Presence is not a lifecycle.** "Retire" and "inactive" imply a terminal
   state. Section 2 shows listings leave search and come back, for causes we
   cannot see.
4. **No period grain.** `is_active` is a fact about the latest run only. The
   questions — what did a listing earn in October, did it rent last year —
   are about periods, and the only period grain today is the estimate
   tables' listing × month.

## 2. Evidence

### Presence toggles

Table 5. Listings by whether they ever left search under the 5-day rule.

| | Listings |
| --- | --- |
| Ever seen | 2,686 |
| Left search on some run | 521 |
| Later seen again under the same `listing_id` | 98 |

Runs are not daily (2026-11-16 to 2026-11-26 had none), so a 5-day grace
counted against the latest run can drop a listing after a single missed run.
A grace counted in runs would not.

### 2026-10-01: a platform removal

Between the 2026-09-30 and 2026-10-01 runs, 257 listings left search and 7
appeared. No scraper change was made that week.

Table 6. Listings on the 2026-09-30 run.

| | Listings | Showing a registration id |
| --- | --- | --- |
| Left search on 2026-10-01 | 257 | 5.8% |
| Stayed | 2,202 | 94.5% |

Table 7. The 257 since.

| | Listings |
| --- | --- |
| Had summer 2027 nights open on 2026-09-30 | 205 |
| Back in search under the same id | 33, of which 30 now show an id |
| Host has a new listing of the same type and bedrooms | 15 |

This is consistent with Airbnb enforcing AMC 10.90.020D, which bars
platforms from taking a fee for a booking on a listing that does not display
its registration id. Most of these hosts were taking summer bookings the day
before. Leaving search here means "removed by the platform for compliance",
not "stopped operating"; some relisted under a new id, which we cannot link
(see Limitations in [methodology](../../methodology.md)). This is also a
finding worth a chapter of its own.

### Calendar patterns among listings in search

Table 1. Listings in search on 2026-11-27, by what the 64 past nights and
the next 365 show.

| Pattern | Rule | Listings | Owner-occupied exemption | Registration not active | Never reviewed | Not an entire home |
| --- | --- | --- | --- | --- | --- | --- |
| Rented | a night seen going from available to not available before its date, or a new review | 1,698 | 24.5% | 5.9% | 6.5% | 12.7% |
| Closed for the season | none of the next 90 nights available, some later | 342 | 28.9% | 1.2% | 7.0% | 11.7% |
| Unbooked | nights available, none seen closing, no new review | 201 | 24.4% | 10.0% | 29.9% | 32.3% |
| Closed | none of the next 365 nights available | 8 | 12.5% | 75.0% | 75.0% | 75.0% |
| **All** | | **2,249** | 25.1% | 5.8% | 8.9% | 14.5% |

Table 2. Of the 342 closed for the season, how many have a night available,
by month.

| Month | Listings |
| --- | --- |
| Nov 2026 – Jan 2027 | 0 |
| Mar 2027 | 40 |
| May 2027 | 263 |
| Aug 2027 | 294 |
| Oct 2027 | 237 |

Unbooked listings mostly once operated (median 20 reviews), and hold 2.5
times the share of rooms and 4.6 times the share of never-reviewed listings.
Examples: a private room, 19332230, with 196 reviews since 2017 and all 63
past nights open; Sunny Spot in Fairview (6912304), 136 reviews since 2015,
57 of 63 past nights open, none seen closing, and 339 future nights open.
Of the 8 closed, six are unregistered and six never reviewed.

No listing in search has a minimum stay above 7 nights on any open night, so
the long-term-rental switch a 30-night minimum would show is not in our data.
A listing that requires 30 nights may not appear in the undated search.

What we cannot see is why: a long-term tenant, an owner living there, a
sale, a vacancy and a forgotten listing produce the same calendar. The
owner-occupied exemption is about 25% in every pattern.

## 3. Proposed model

Three layers. Each has its own grain and its own words, and no word is used
in two layers.

```
Layer             Grain                         Source of truth          Words
---------------   ---------------------------   ----------------------   ------------------------------
Presence          listing × run                 search results           in search; left / returned to search
Offering & use    listing × night               calendar, reviews        available, not available (observed)
                  → listing × month                                      offered, booked, blocked (estimates)
                  → listing × 365 nights                                 closed, unbooked, rented; dormant, seasonal, FREH
Operating         dwelling or room × period     estimate across          operating
                                                listings and platforms
Muni permission   registration, license         license pages            active / lapsed; valid / expired
```

### Presence

**In search** replaces "active" for a listing: seen by a run within the
grace, `is_in_search`, `listings_in_search`. It says exactly what is
observed, so nobody reads it as rented. **Left search** and **returned to
search** replace "retire" and "inactive" and say nothing about why — the
host hid it, deactivated it, or Airbnb removed it. UI copy may say "on
Airbnb". The grace becomes a number of runs.

"Listed" was the other candidate. It reads better in prose, but it is
Airbnb's own host-side status (Listed, Snoozed, Unlisted), which we never
see, and it yields `listings_listed`.

### Offering and use

The night states stay as they are. Two words are added:

- **Offered night**: available, or booked. The host was willing to rent it.
  FREH already counts these as "open or booked".
- **Rented**, of a listing in a period: at least one booked night or one new
  review in it. An estimate, with the low, middle and high models.

A listing × period in search is then exactly one of:

| | No booked night | A booked night or new review |
| --- | --- | --- |
| **No offered night** | **closed** | — (a booked night is offered) |
| **Offered nights** | **unbooked** | **rented** |

Over 365 nights, three classifications sit side by side, all in the viewer:

- **FREH**: as now.
- **Dormant**: in search for the window, and not rented in it. Provisional
  below 365 nights, as FREHM is.
- **Seasonal**: rented, with a closed stretch of at least 60 consecutive
  nights. The threshold is a viewer constant.

### Operating

Unchanged in meaning, made explicit in grain: a dwelling or room is
operating **in a period**. It needs dwellings
([#40](https://github.com/NickCrews/anchorage-str-db/issues/40)) and combo
links ([#38](https://github.com/NickCrews/anchorage-str-db/issues/38)) to
estimate: operating if any of its listings was rented in the period, on any
platform. Until then a listing's "rented" is the proxy, and copy must say
"listings rented", not "STRs operating".

Crossing operating with registration gives the policy table: operating and
registered, operating and unregistered, registered and not operating. The
last is the Muni-side twin of a dormant listing.

### Muni permission

"Active" stays on registrations, where it is the Muni's status word, and is
used nowhere else. `licenses.is_active` (latest issuance `Active` or
`Issued`) is a different test under the same name and should become
`is_issued` or be defined as the registration's test.

### What is stored where

The database keeps presence (it is observed). Offering and use stay in the
viewer, as the night states do now. `est_listing_months` gains
`nights_in_search`, `nights_offered`, `new_reviews` and a `pattern`
column; a new `est_listing_activity` holds the 365-night classifications
beside `est_listing_frehm`, with counts and a reason in words. No cause
(long-term rental, sold, owner-occupied) is stored: nothing observed tells
them apart.

One new field would settle dormancy now instead of in a year: the date of
the most recent review. The reviews endpoint the first-review pass uses sorts
newest first, so it costs one request per listing, and can be refreshed
weekly.

## 4. Effect on the analysis

Table 3. October 2026 earnings by pattern, middle model.

| Pattern | Listings with October data | Median earnings | No booked night |
| --- | --- | --- | --- |
| Rented | 1,668 | $1,438 | 425 |
| Closed for the season | 327 | $0 | 251 |
| Unbooked | 174 | $0 | 165 |
| Closed | 1 | $0 | 1 |
| **All** | **2,170** | **$772** | **842** |

Table 4. The October median under each inclusion rule.

| Included | Median | Listings |
| --- | --- | --- |
| Every listing in search (the viewer now) | $772 | 2,170 |
| Without closed and unbooked | $1,040 | 1,995 |
| Rented only | $1,438 | 1,668 |

"Rented only" is circular — it is selected on the bookings that make the
earnings — and bounds the effect rather than being a rule.

**"What does an operating STR earn?"** (ListingRevenue, Incentives):
exclude dormant listings; keep seasonal ones and measure them over a year,
since a January median reads every seasonal operator as earning nothing.
Decide dormancy on evidence outside the period being measured.

**"What does Airbnb in the Muni earn, and the room tax?"** (HostRevenue
totals, MuniIncome): every listing in search. Dormant listings add nothing
to a total.

**Supply**: "listings on Airbnb" and, beside it, "rented in the last year";
never one number called active.

**FREH**: no change. A dormant listing already fails its booked threshold.

**Viewer controls**: a pattern column and filter in the listing table, and a
Methodology switch for whether per-listing figures include dormant listings,
default off, with the number excluded beside each affected median.

### Biases

- **Including dormant listings** understates an operator's earnings, and so
  the incentive to convert a dwelling.
- **Excluding them** overstates it when the rule catches operating listings
  in a bad stretch, and shifts the remainder toward established entire
  homes: unbooked holds a third of rooms and many never-reviewed listings.
- **Nights seen closing** count a host's own short blocks as rented, so the
  rule errs toward not calling a listing dormant.
- **Reviews** favour many short stays over a few long ones.
- **Windows under 365 nights** call seasonal operators dormant in winter.
- **Presence** undercounts: a listing Airbnb removed may still operate on
  another platform or under a new id.
- **Combo listings** never booked whole read as dormant while their
  components rent; excluding them from earnings loses no bookings.

## 5. What the rename touches

The Airbnb side only; the Muni side keeps its words.

| Now | Proposed |
| --- | --- |
| `listings.is_active` | `is_in_search` |
| `listings_active`, `listings_active_with_host`, `listings_active_with_registration` | `listings_in_search`, `..._with_host`, `..._with_registration` (old names in `DROPPED_VIEWS_SQL`) |
| `host_listing_portfolios.listings_active` | `listings_in_search` |
| `registrations.airbnb_listings_active` | `airbnb_listings_in_search` |
| `RETIREMENT_GRACE_DAYS` (5 days) | `SEARCH_GRACE_RUNS` (a count of runs) |
| `airbnb_scrape_runs.listings_retired` | `listings_left_search`, a hand-written rename migration |
| TERMINOLOGY: Active (listing), Inactive, Retire | In search, Left search, Returned to search; Offered night, Rented, Closed, Unbooked, Dormant, Seasonal |
| `licenses.is_active` | `is_issued` |

About 250 references across `packages/db`, `airbnb-scraper` checks and
tests, the viewer, `docs/policy_questions.sql`, `tables.md` and
`methodology.md`. The published database's view names are a public
interface, which methodology already calls unstable.
