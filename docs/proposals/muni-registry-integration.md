# Integrating the municipal STR registry

Proposals for joining the Municipality's short-term rental registrations to
the Airbnb archive. Background on the source is in
[`docs/research/anchorage-str-registry.md`](../research/anchorage-str-registry.md);
the scraper is `packages/registry`.

Nothing here is decided. `packages/registry` implements **Proposal A**
because it is the smallest thing that works and the other three build on the
same tables, not because it is the last word.

## What is already in place

The join key exists on both sides today.

- **Airbnb side.** Every run reads each listing's page for the municipal
  registration number and stores it as
  `listing_observations.str_registration_id`. It is part of `VERSION_KEY_SQL`,
  so a host adding or removing a number opens a new listing version — which
  means the archive already holds *when* each listing started displaying one.
  That is the compliance-adoption curve, for free.
- **Municipal side.** `packages/registry` stores the registry's own number,
  normalized the same way.

Both sides are reduced to the same key before matching: uppercase, letters
and digits only, and rejected unless it contains a digit, so `STR-2026-0001`,
`str 2026 0001` and `STR20260001` meet, while `N/A` and `pending` match
nothing — including each other. That normalization lives in
`normalizeRegistrationId` (TypeScript, municipal side) and the
`registration_key` SQL macro (Airbnb side); a test asserts the two agree case
by case, because if they drift, listings silently stop matching their own
registrations and nothing else says so.

## The proposals

### A. Both sides in one file, joined by views *(implemented)*

The registry's tables go into the same `anchorage_str.duckdb`, and two views
do the join: `listing_registration_matches` (a FULL JOIN, one row per
listing-registration pair) and `listing_registration_coverage` (the counts).

```
str_registration_versions ─┐
                           ├─ listing_registration_matches ─ listing_registration_coverage
listings_current ──────────┘
```

- **For it.** Additive: new table names, `CREATE TABLE IF NOT EXISTS`, no
  change to the scraper, and per CONTRIBUTING a new table reaches the
  published database in place without a rebuild. One download gets a
  downstream user both sides. The coverage checks run in the pipeline, so
  the match rate is measured and logged every day rather than when someone
  remembers to ask.
- **Against it.** Two writers, one file. The daily workflow takes ~50
  minutes and re-uploads the release asset; a registry job running
  independently would have to either join the `str-scrape` concurrency group
  (and wait out the scrape) or risk clobbering it.
- **The fix**, and the recommendation: run the registry as a *step inside*
  `daily.yml`, after the scrape and before the upload. It adds seconds to a
  50-minute job, needs no new concurrency group, and puts both histories on
  the same date grid. Its failure must not fail the workflow — a municipal
  server that is down should not withhold a day of Airbnb calendars, which
  cannot be scraped after the fact — so the step is `continue-on-error`, and
  the registry's own error-severity checks still mark the run in
  `registry_runs.error_summary`.

### B. A separate published file, attached on demand

`anchorage_str_registry.duckdb` as its own release asset and its own
workflow.

- **For it.** Fully independent cadences and failure domains. The registry
  could refresh hourly and the scraper daily. A downstream consumer who wants
  only the registry downloads ~1 MB instead of the whole archive. No
  concurrency question at all.
- **Against it.** Every cross-source query needs `ATTACH`, which the browser
  viewer would have to learn. The coverage checks cannot run in either
  pipeline without attaching the other side, so the most interesting number
  this project can produce stops being measured automatically.
- **When to switch to it.** If the registry ever needs a cadence the daily
  scrape cannot carry, or if the published file grows enough that splitting
  it is worth doing anyway.

### C. Registration columns on the listings dimension

A `listings_with_registration` view: `listings` plus `registration_status`,
`registration_address`, `parcel_id`, `expires_date`.

- **For it.** The easiest thing for a consumer to use. "Is this listing
  registered, and is the registration current?" becomes one table and no
  join.
- **Against it.** The match is many-to-many, so it cannot be a set of columns
  without a rule for which registration wins when a listing's number covers
  several records — and the rule would be invisible to whoever reads the
  view. It also crosses two different clocks: a listing version and a
  registration version open on unrelated days, so "the registration status
  as of listing version 3" is a question the view would answer without ever
  being asked it.
- **If we do it.** As a view over `listing_registration_matches`, never as
  columns on `listing_observations`, with the tie-break stated in the view's
  own comment (take the current registration, most recently issued). Cheap to
  add on top of A, and worth doing once the match rate is known to be high
  enough that the view is not mostly nulls.

### D. A premises spine

Both sides resolve to a `premises` entity — a physical unit, keyed by parcel
— with `listing → premises` and `registration → premises` edges. The
registration number becomes one kind of edge among several: address match,
parcel match, coordinate proximity.

- **For it.** It is the only proposal that helps the listings that show *no*
  number, which is exactly the population an enforcement question is about. A
  listing with no number but an exact coordinate inside a parcel that holds a
  registration is a finding; under A-C it is invisible. It also generalizes
  to Vrbo, whenever that happens, and to the parcel and voter data the PRD
  names as downstream joins.
- **Against it.** Much the largest piece of work, and the only one that
  requires judgment calls this repo has so far avoided: fuzzy address
  matching, a confidence score, and a rule for what counts as a match. The
  PRD says this repo is feedstock and holds no opinions; a probabilistic
  premises link is an opinion.
- **Where it belongs.** Probably a separate repo that consumes this one and
  `anchorage-property`, publishing its own crosswalk. That keeps the
  judgment calls out of the archive and lets them be revised without
  rewriting history.

### Recommendation

A now, D later, C when the data justifies it, B only if forced.

A is a day of work that is already done, and it makes the coverage question
measurable tomorrow. That measurement decides everything else: if most
listings show a valid number, C is worth adding and D is a refinement; if few
do, D is the whole game and C would be a view of nulls.

## The join: how much will it actually cover?

**Unmeasured, and the most important open question.** The honest answer needs
one query against the published archive and one run of the registry.

### Measure the Airbnb side today

This needs no registry at all — the number has been scraped since the
listing-page pass was added:

```sql
SELECT
    count(*) AS current_listings,
    count(str_registration_id) AS showing_a_number,
    round(100.0 * count(str_registration_id) / count(*), 1) AS pct
FROM listings WHERE is_current;
```

The daily log line says the same thing (`… N with an STR registration
number`). And because the number is in the version key, the adoption curve is
already there:

```sql
-- Listings displaying a number, by day, across the 2026-07-31 deadline.
SELECT valid_from, count(*) FILTER (WHERE str_registration_id IS NOT NULL) AS with_number
FROM listings GROUP BY valid_from ORDER BY valid_from;
```

### Then measure the join

Once both sides are in the file, `listing_registration_coverage` splits every
current listing and registration into four:

| `match_kind` | what it is |
| --- | --- |
| `matched` | the listing's number is a current registration |
| `listing_unregistered` | the listing shows no number, or shows something that is not one |
| `listing_number_unmatched` | it shows a number the registry does not hold — a typo, a lapsed registration, or a fabricated one |
| `registration_only` | a registration with no Airbnb listing — Vrbo, direct booking, or not found by the search |

The pipeline logs both rates on every run, so the trend is in the history
rather than in someone's notebook.

### What to expect

Three things cut the match rate, and only the first is our problem:

1. **Hosts who leave the field blank.** Anchorage requires the number in the
   advertisement, but the requirement binds the host, not the platform. Where
   platforms have not enforced it themselves, display rates elsewhere have
   run well under half; where they have, they approach complete. Whether
   Airbnb enforces it for Anchorage is unknown and is the single biggest
   driver of the number.
2. **Hosts who type it wrong.** Normalizing both sides absorbs spacing, case
   and punctuation. It deliberately does not absorb a wrong digit or a
   dropped prefix — that is analysis, where a bad guess can be seen and
   undone, not a stored key. `listing_number_unmatched` is where these
   land, and its size says whether looser matching is worth writing.
3. **Registrations with no Airbnb listing.** Not a defect: it is a real
   measurement of how much of the registered stock is on other platforms.

The deadline was 2026-07-31, six weeks ago, so the current rate is a
transitional one either way, and the daily series matters more than any
single day's figure.

### The address bonus

Worth stating plainly: **every matched listing gains a street address and a
parcel id.** The PRD defers listing addresses as a public-records request,
and about half of Airbnb's coordinates are privacy jitter. A registration
carries the real address. For the matched population, the registry resolves
the archive's largest known gap at no extra cost — and that is a second,
independent argument for D, which would extend it to the unmatched ones.

## Temporal modelling: snapshots or diffs?

**Change-only (SCD2), which is what the package does.** The reasoning, and
the three traps it has to avoid.

### The arithmetic

Roughly 3,000 registrations. A registration opens on the order of one to
three new versions a year — a status change, a renewal, an occasional change
of operator — and its address, parcel, coordinate and number never move. See
the per-field table in the research doc.

| | first year | steady state |
| --- | --- | --- |
| daily snapshot | ~1,095,000 rows | ~1,095,000 rows/yr |
| change-only | ~3,000 + ~6,000 = ~9,000 rows | ~6,000 rows/yr |

About 120× fewer rows, for exactly the same information. The published
`.duckdb` is downloaded whole by the browser viewer, so this is not a
theoretical saving.

It is also the choice this repo already makes for data shaped this way:
`calendar_status` and `listing_photos` are change-only for the same reason.
`listing_observations` is stored daily instead, and the difference is not
inconsistency — its rows carry values that genuinely differ every day (price,
rating, review count), so a daily row earns its place. A registry row is
byte-identical for months at a time.

### The three traps, and how each is handled

1. **Absence becomes silent.** With no daily row, "unchanged" and "not looked
   at" are the same nothing. Two things separate them: every run reads the
   layer *in full*, so a record that stops appearing has its interval closed
   on that date and `str_registrations.removed_date` says when; and
   `registry_runs` holds a row per run, so a gap in the history is visible as
   a day with no run rather than read as a quiet day.
2. **A partial extract looks like a mass deletion.** If a run read a tenth of
   the layer, the merge would close nine tenths of the registry as removed,
   and the next full run would reopen them all as new. Three guards:
   `queryByObjectIds` counts what came back against what it asked for, so a
   truncated batch raises rather than returning short; an extract is
   all-or-nothing; and the merge refuses outright when the extract is more
   than 10% smaller than the last one.
3. **A republish looks like a total rewrite.** Municipal layers are commonly
   refreshed by truncate-and-append, which rewrites `OBJECTID`, `GlobalID`
   and the edit stamps for every row at once. The version hash excludes all
   of them, and the `change_rate_plausible` check warns if a quarter of the
   registry versions in one run anyway.

### When a snapshot would have been right instead

If the source carried a volatile per-row measurement (it does not), or if the
extract were filtered rather than complete (it is not, deliberately). Neither
is true, and if either becomes true the storage decision should be revisited
rather than patched.

### Cadence

**Daily**, matching the scrape. Not because the data needs it — weekly would
lose very little, and the change is bursty around the annual renewal rather
than steady — but because a refresh is a handful of requests and a few
seconds, and sharing a date grid with the Airbnb side makes the match-rate
series a clean daily join instead of an interpolation.

Both sides' histories then answer the questions this project exists for:
how many listings became compliant and when, how many registrations never
appear on Airbnb, and what happens to a listing after its registration
lapses.
