# Dormant listings: active on Airbnb, not operating

As of the 2026-11-27 Airbnb run, with 36 runs on record from 2026-09-24.
Every count comes from a query in [queries.sql](queries.sql), run after the
viewer's estimate tables are built. Answers
[#85](https://github.com/NickCrews/anchorage-str-db/issues/85).

**Goal:** find the active listings whose dwelling or room is not operating —
now a long-term rental, owner-occupied, vacant, sold, or simply never taken
down — and decide how they should change the analysis.

**Summary:** Four calendar-and-review patterns separate the 2,249 active
listings: 1,698 show activity (a night seen closing, or a new review), 342
are closed for the season and open again in spring, 201 are open with no
activity at all, and 8 have no bookable night in the next year. The cause
behind a pattern (long-term tenant, sale, vacancy) is not observable and
should not be stored. Two months of autumn data cannot tell a dormant
listing from a slow season: like FREH, the test needs 365 nights, and until
then any answer is provisional. One cheap new field, the date of the most
recent review, would give years of history now. Excluding dormant listings
moves the October median listing's earnings from $772 to $1,040, so the
choice matters, and the rule must not be based on the same bookings it then
measures.

---

## Words

**Active** and **operating** are defined in
[TERMINOLOGY.md](../../TERMINOLOGY.md): active is a record still in search;
operating is the dwelling or room actually rented as an STR. The gap between
the two is this doc's subject. **Inactive** is already taken (a listing no
longer in search), so it cannot name this.

Proposed for TERMINOLOGY.md:

> **Dormant**:
> Of an active listing: no sign of a stay over the last 365 nights — no night
> seen going from available to not available before its date, and no new
> review — or no bookable night in the next 365. Evidence the dwelling or room
> is not operating, not proof: a host may decline every request, and a stay
> may leave no review. Says nothing about why — a long-term tenant, an owner
> living there, a sale, a vacancy and a forgotten listing look the same. Like
> FREH, only at the full 365 nights; over fewer it is provisional.
> `est_listing_dormancy.is_dormant` in the viewer.
> _Avoid_: inactive (a listing out of search), ghost, zombie, stale, dead,
> abandoned

**Closed for the season** is not dormant: the calendar is shut now and open
later. It is the normal shape of a seasonal operator in Anchorage, and over
365 nights it shows activity in its open months.

## 1. Signals we already hold

| Signal | Source | What it says | Weakness |
| --- | --- | --- | --- |
| Night seen closing | `airbnb_calendar_status`: available on one run, not available on a later run before the night | someone booked it, or the host blocked it | a host blocking a few nights reads as a booking; a booking made before we first read the night is not seen |
| New review | `airbnb_listing_observations.review_count` rising | a stay ended in the last few weeks | many stays leave no review; lags checkout by up to 14 days |
| Future nights available | `calendar_current` | whether the host is taking bookings at all | an open calendar can be a default nobody turned off |
| Price quote | `quote_total` | a stay can be priced | absent exactly when the calendar is closed, so it adds nothing |
| Registration lapsed or missing | `registrations.is_active` | the Muni is not told it operates | many operating listings are unregistered |
| Owner-occupied exemption | `property_parcels.exemption_types_all` | the owner claims to live there | 25% of every pattern, so it does not discriminate |

`min_nights` would catch a host who turned the listing into a 30-night
rental, but no active listing has a minimum above 7 on any open night. A
listing that requires 30 nights may not appear in our undated search, and so
is inactive here rather than dormant.

## 2. Four patterns

Table 1. Active listings, 2026-11-27.

| Pattern | Rule | Listings | Owner-occupied exemption | Registration not active | Never reviewed | Not an entire home |
| --- | --- | --- | --- | --- | --- | --- |
| With activity | a night seen closing, or a new review | 1,698 | 24.5% | 5.9% | 6.5% | 12.7% |
| Closed for the season | none of the next 90 nights available, some later | 342 | 28.9% | 1.2% | 7.0% | 11.7% |
| Open, no activity | nights available, none seen closing, no new review | 201 | 24.4% | 10.0% | 29.9% | 32.3% |
| Closed | none of the next 365 nights available | 8 | 12.5% | 75.0% | 75.0% | 75.0% |
| **All** | | **2,249** | 25.1% | 5.8% | 8.9% | 14.5% |

**Closed for the season** is seasonal, not dormant. Table 2 counts, by
month, the 342 listings with at least one night available:

| Month | Listings |
| --- | --- |
| Nov 2026 – Jan 2027 | 0 |
| Mar 2027 | 40 |
| May 2027 | 263 |
| Aug 2027 | 294 |
| Oct 2027 | 237 |

Each has a night available somewhere in the next year, by the rule; 263 of them
by May. Summer 2027
will show whether those calendars take bookings.

**Open, no activity** is the dormant candidate. The median listing in it had
every past night available (the calendar never closed), and the median has
20 reviews, so most once operated. It holds two and a half times the share
of rooms and four and a half times the share of never-reviewed listings.
Examples: a private room, 19332230, with 196 reviews since 2017 and all 63
past nights open; Sunny Spot in Fairview (6912304), 136 reviews since 2015,
57 of 63 past nights open, none seen closing, and 339 future nights open. Two quiet months in October and November are not
enough to call either dormant.

**Closed**: 8 listings, six unregistered and six never reviewed. These look
like listings created and never launched, or shut and left up.

## 3. Why the test needs 365 nights

Anchorage's season makes any window shorter than a year misleading. In
November, 342 listings are closed for the winter and would read as dormant
by a 90-day rule; in July they would not. The window also has to cover a
listing's own open months: a listing open only from May to September shows
no activity from October to April by design.

Today's history is 64 past nights, all in the shoulder and off season. So:

- Dormancy should follow FREH: decided at 365 past nights, provisional below,
  with the same `NULL` until then.
- The most recent review date would answer it from Airbnb's own history
  instead of ours. The reviews endpoint already used for the first review
  sorts newest first, so the first page of it gives the latest review in one
  request per listing. "No review in the last 365 days" is a common proxy for
  an inactive listing in STR research, and with it the 201 above
  could be split now. Storing it fits `airbnb_listing_first_reviews`'s pattern,
  refreshed weekly rather than once.

## 4. Earnings

Table 3. October 2026 earnings by pattern, middle model.

| Pattern | Listings with October data | Median earnings | No booked night |
| --- | --- | --- | --- |
| With activity | 1,668 | $1,438 | 425 |
| Closed for the season | 327 | $0 | 251 |
| Open, no activity | 174 | $0 | 165 |
| Closed | 1 | $0 | 1 |
| **All** | **2,170** | **$772** | **842** |

Table 4. The October median under each rule.

| Included | Median | Listings |
| --- | --- | --- |
| Every listing (the viewer now) | $772 | 2,170 |
| Without closed and open, no activity | $1,040 | 1,995 |
| With activity only | $1,438 | 1,668 |

The last row is circular: "with activity" is selected on the bookings that
make the earnings, so it drops every listing that earned nothing and its
median can only rise. It is shown to bound the effect, not as a rule.

## 5. Proposal

### Classify in the viewer, not the database

The database records what the sources say; dormancy is an interpretation
with tunable thresholds, like booked and blocked. Add
`est_listing_dormancy` to `packages/ui/src/model/`, one row per listing,
beside `est_listing_frehm`:

- the counts it reads: past nights, nights seen closing, new reviews, future
  nights available, next-90 nights available;
- `pattern`: with activity, closed for the season, open with no activity,
  closed;
- `is_dormant`: decided at 365 past nights, NULL below; `is_dormant_provisional`
  over the nights on record;
- a reason in words, as `frehm_reason` does.

Constants `DORMANT_WINDOW_NIGHTS = 365` and `SEASON_CLOSED_NIGHTS = 90`.

Do not store a cause (long-term rental, sold, owner-occupied). Nothing we
observe tells them apart, and a stored guess would be read as a fact. The
Muni signals (lapsed registration, a change of owner of record since the
registration was issued, which anchorage-property's history could date)
belong in the listing detail as context, not in the rule.

### Two questions, two denominators

**"What does an operating STR earn?"** (ListingRevenue, Incentives): exclude
dormant listings. Include listings closed for the season, and measure them
over a year, not a month, once there is a year: a monthly median in January
reads every seasonal operator as earning nothing. Decide dormancy on
evidence outside the month being measured — the other months of the window,
the review history, the future calendar — so the rule does not select on the
outcome.

**"How much does Airbnb in the Muni earn, and how much room tax?"**
(HostRevenue totals, MuniIncome): include every active listing. A dormant
listing adds nothing to a total, so the totals do not move; only shares
"per listing" do.

**Supply**: report active listings and, beside them, how many are dormant,
so "2,249 listings" is not read as 2,249 operating STRs.

**FREH / housing impact**: no change. A dormant listing fails FREH's booked
threshold already, and a dormant listing in a long-term rental is housing
that is already back on the long-term market.

**Viewer controls**: a "Dormant" column and filter in the listing table, and
a Methodology switch for whether per-listing figures include dormant
listings, default off, with the count excluded printed beside every
affected median.

### Biases each choice brings

- **Including dormant listings** understates what an operator earns, and so
  understates the incentive to convert a dwelling to an STR. It counts
  forgotten listings as supply.
- **Excluding them** overstates it if the rule also drops operating
  listings that had a bad stretch: a listing priced too high, one that
  declines requests, one with a new host. Open, no activity holds a third of
  rooms and many never-reviewed listings, so excluding it shifts the
  remainder toward established entire homes.
- **Reviews as evidence** favour listings with many short stays (more
  reviews) over a few long ones, and miss listings whose guests do not
  review.
- **Nights seen closing as evidence** count a host's own blocked nights as
  activity, so a dormant listing whose owner blocks a weekend now and then
  reads as operating. This errs toward not calling a listing dormant.
- **Seasonality** is the largest: any window under 365 nights calls
  seasonal operators dormant in winter and active in summer.
- **Combo listings** ([#38](https://github.com/NickCrews/anchorage-str-db/issues/38)):
  a combo that is never booked as a whole while its components are reads as
  dormant though its dwellings operate. Excluding it from earnings loses no
  bookings, since its components carry them.
