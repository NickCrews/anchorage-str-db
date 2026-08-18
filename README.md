# girdwood-str-lake

A daily scrape of Girdwood, Alaska's Airbnb short-term rental listings —
which houses are operating as STRs, which nights are booked, which are
open — into a DuckDB database with full history. Built for the Girdwood
Board of Supervisors' housing-policy research: the town's rental housing
stock is small, and STR conversion is one of the standing hypotheses for
why it's shrinking. This turns "how many houses are STRs?" from a guess
into a number with a receipt.

## What it collects, daily

1. Every Airbnb listing inside the Girdwood Valley Service Area bounding
   box (see [`config.py`](src/girdwood_str/config.py) for how that bbox was
   derived from actual parcel data, not eyeballed).
2. Each of those listings' full forward availability calendar (~12 months
   out): which nights are open, which are booked/blocked, minimum-stay
   rules.

Both are merged into the database as **SCD2 history** — a new version row
is only written when something actually changed, so the archive grows with
real change, not with daily noise.

## The three tables

- **`listings`** — one row per listing *version*: name, bedroom/bed/bath
  counts, coordinates, badges. `valid_from`/`valid_to`/`is_current` bound
  each version; `first_seen_date`/`last_seen_date` track how long a listing
  has been (and remained) visible in search results.
- **`listing_observations`** — one row per (listing, day) it was seen
  active: rating, review count, a rough nightly price hint. Append-only —
  this is what answers "how many distinct STRs operated in the last year."
- **`calendar_status`** — SCD2 on (listing, night): was that specific night
  available. Once a night scrolls out of Airbnb's forward calendar window
  its last known value just freezes, which happens to be exactly the
  realized booked/vacant call for a night once it's in the past — no
  special handling needed. **Caveat:** `available = false` means "not
  bookable," which conflates a real guest booking with a host manually
  blocking the night (maintenance, personal use, etc.) — the calendar
  can't distinguish the two. This is the same limitation
  [Inside Airbnb's](https://insideairbnb.com/) occupancy estimates have.
- **`scrape_runs`** — one row per run: counts, failures, for monitoring the
  pipeline itself.

See [`queries/policy_questions.sql`](queries/policy_questions.sql) for
ready-made SQL answering the questions this was built for: nightly
operating/booked counts, distinct STRs over the last year, bedroom-size mix
of the STR inventory, and (commented out, needs the parcel lake attached) a
join against [anchorage-property](https://github.com/NickCrews/anchorage-property)
to identify *which specific parcels and owners* are running STRs — including
ones claiming the owner's-primary-residence tax exemption while doing it.

## Quick start

```sh
gh release download latest-data --repo <owner>/girdwood-str-lake -O girdwood_str.duckdb
duckdb girdwood_str.duckdb
```

```sql
SELECT count(*) FROM listings WHERE is_current;
```

## How the scrape works

No API key: Airbnb doesn't publish one for this. The scraper (via
[pyairbnb](https://github.com/johnbalvin/pyairbnb)) talks to the same
internal GraphQL endpoints the airbnb.com map search and listing pages use
— `StaysSearch` for the bbox search, `PdpAvailabilityCalendar` per listing
— the same category of technique [Inside Airbnb](https://insideairbnb.com/)
and the STR-research literature (e.g.
[Adamiak 2024, PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0298131))
use to study this market, since there's no public API for it. Because
that's unofficial API surface rather than a stable contract, it can change
without notice — `airbnb_client.py` is kept as the only two calls into the
library so a breakage is easy to localize and fix.

The scrape is deliberately polite: calendar requests are capped at 4
concurrent, spaced ~0.4–1.2s apart, and the whole run (~250 listings) takes
a few minutes once a day — not a burst.

## Data source & limitations

- **Airbnb only, for now.** Vrbo/Expedia has a meaningful presence in
  Girdwood too and isn't collected yet — see
  [CONTRIBUTING.md](CONTRIBUTING.md) for why and what adding it would take.
- **"Booked" isn't verified against a real reservation** — see the
  `calendar_status` caveat above.
- **History starts at first ingest**, not retroactively. "STRs over the
  last year" only means something once the archive has run for a year;
  until then it under-counts.
- A listing's *exact* physical address isn't in Airbnb's data (they
  obscure it before booking) — `lat`/`lng` are approximate (Airbnb jitters
  pin locations somewhat for unbooked guests), which is why the parcel
  join in `queries/policy_questions.sql` is nearest-centroid-within-60m,
  not an exact match, and should be spot-checked before being treated as
  ground truth for any specific address.

## Notes & caveats

- This repo (and its published data) defaults to **private** — STR-level,
  near-address-precision scrape data about specific properties is more
  sensitive than the tax-roll data in `anchorage-property`, which is
  already public record. Ask before making it public.
- All dates are UTC calendar dates.
