# Airbnb's removal of listings without a registration id

Researched 2026-11-28, from the database as of the 2026-11-27 run. Numbers
come from [queries.sql](queries.sql).

**Summary:** Between the 2026-09-30 and 2026-10-01 runs, 257 listings left
Airbnb search at once. Between other runs up to three days apart, 3 to 16
listings drop out, apart from two runs where search left out about 140
listings for one day. 94% of
the 257 showed no Muni STR registration id, against 5.5% of the listings
that stayed. 205 still had summer 2027 nights open, and 30 of the 33 that
have come back now show an id. This fits Airbnb enforcing
[AMC 10.90.020D](../rental-units/README.md#3-what-the-ordinance-says-a-registration-covers),
which bars a platform from collecting a fee for a booking on a listing that
does not display its registration number. So most of these listings went
inactive because Airbnb removed them, not because their hosts stopped
renting.

## The drop

| Runs | Listings that dropped out |
| --- | --- |
| Other runs up to three days apart, 2026-09-24 to 2026-11-27 | 3 to 16 |
| 2026-09-30 → 2026-10-01 | 257 |
| 2026-10-08 → 2026-10-09 | 132, all with an id; 126 back the next run |
| 2026-10-20 → 2026-10-21 | 151, 2 without an id; 145 back the next run |
| 2026-11-16 → 2026-11-26 (10 days apart) | 79, 41 without an id; 6 back the next run |

The 2026-10-09 and 2026-10-21 drops are search leaving listings out for a
day: the listings had ids and nearly all came back on the next run. The
2026-10-01 drop is the reverse on both counts.

The scraper did not change between the 2026-09-30 and 2026-10-01 runs. The
2026-10-01 run reported no errors and read every page but 5, and it kept
2,202 of the 2,459 listings. A fault in the scraper would not pick out the
listings that lack an id.

## What the removed listings have in common

| | Removed | Stayed |
| --- | --- | --- |
| Listings on 2026-09-30 | 257 | 2,202 |
| Showing no registration id | 242 (94.2%) | 122 (5.5%) |

- **Type:** 206 entire homes, 50 private rooms, 1 hotel room.
- **Hosts:** 141 hosts. One host had 48 of the 257 listings.
- **Calendars:** 205 had at least one night from June to August 2027
  available on the calendar as of 2026-09-30. A host who is shutting down
  usually closes the calendar. Some hosts never change their calendar
  settings, so an open calendar is evidence the listing was still operating
  but does not prove it.

## Listings that came back

33 of the 257 have reappeared in search since 2026-10-01, most of them
within two weeks.

| On 2026-09-30 | On latest run | Listings |
| --- | --- | --- |
| no id | id | 25 |
| id | id | 5 |
| no id | no id | 3 |

25 of the 28 that came back without an id now show one. That fits a host
adding the id and Airbnb relisting the listing.

## What this does not show

- Airbnb has not said that it removed these listings, or why. The Muni or
  Airbnb could confirm whether there was an enforcement date or a notice to
  hosts.
- The 15 removed listings that did show an id are not explained. Airbnb may
  have checked the id against the Muni's records, or they may have left for
  unrelated reasons, at the normal rate of a few a day.
- The 224 listings that have not come back may have moved to another
  platform, kept renting off-platform, or stopped. The data cannot tell them
  apart.
- The 79 listings that dropped out between 2026-11-16 and 2026-11-26 are 52%
  without an id. That may be a smaller second removal; the 10-day gap
  between runs hides when they left.

## What follows for analysis

An inactive listing is one Airbnb search no longer shows. It is not evidence
that the rental stopped operating. Counts of listings that went inactive in
October 2026 mostly measure Airbnb's enforcement of the registration
requirement, not hosts leaving the market. The listings that remain active
after 2026-10-01 are mostly ones that display an id, so a comparison of
registered and unregistered listings across that date compares different
populations.

## Files

| File | What it is |
| --- | --- |
| [queries.sql](queries.sql) | The drop per run, the registration ids, calendars and hosts of the removed listings, and the ones that came back. |
