# `@anchorage-str-db/registry`

The Municipality of Anchorage's short-term rental registrations, read from
its ArcGIS Feature Service into the same DuckDB file as the Airbnb archive.

The registration number links the two: the scraper reads it off each Airbnb
listing page (`listings.str_registration_id`), and this package reads the
Municipality's own copy. See
[`docs/proposals/muni-registry-integration.md`](../../docs/proposals/muni-registry-integration.md)
for how far that join is expected to get, and
[`docs/research/anchorage-str-registry.md`](../../docs/research/anchorage-str-registry.md)
for the source itself.

## The endpoint is not configured yet

There is no default layer URL, and a run without one is a usage error rather
than a guess. The Clerk's program page links the registration portal, not a
dataset, and pointing this at the wrong layer would scrape real,
plausible-looking rows of the wrong thing.
[`docs/research/anchorage-str-registry.md`](../../docs/research/anchorage-str-registry.md),
"Finding the endpoint", says where to look.

Once you have a candidate, `probe` describes it and writes nothing:

```sh
node src/cli.ts probe 'https://services1.arcgis.com/…/FeatureServer/0'
```

It prints the layer's name and record count, every field beside the column
`src/fields.ts` mapped it to, and a few records as they would be stored. If a
column reads `-`, add that field's name to `FIELD_ALIASES`.

## Running

```sh
export ANCHORAGE_STR_REGISTRY_URL='https://…/FeatureServer/0'
pnpm registry                       # from the repo root
pnpm registry --verbose --db /tmp/scratch.duckdb
```

A run reads the whole layer (a handful of requests, seconds), merges it in
one transaction, and runs the quality checks. It exits non-zero if an
error-severity check fails.

## Tables

- `str_registration_versions`: SCD2 on `record_key`. One row per registration
  per distinct attribute set, with `valid_from`/`valid_to`/`is_current`.
- `str_registrations` *(view)*: the same, plus `first_seen_date` and
  `removed_date` (when the registration left the layer, NULL while it is
  still there). `str_registrations_current` filters to `is_current`.
- `registry_runs`: one row per run, including `layer_last_edit` — the layer's
  own last-edited stamp, recorded whether or not anything changed.

When the scraper's `listings_current` is in the same file, two more views
appear:

- `listing_registration_matches`: a FULL JOIN of current listings and current
  registrations on the normalized number, one row per pair, with a
  `match_kind` of `matched`, `listing_unregistered`,
  `listing_number_unmatched` or `registration_only`.
- `listing_registration_coverage`: those four, counted.

Each record also stores its complete ArcGIS `attributes` object as JSON.
That is the authoritative copy: the mapped columns are a convenience, and a
column `fields.ts` did not recognize can be mapped later from stored data.
A current-state layer with no history gives no second chance otherwise.

## Design decisions

- **Change-only storage, not a daily snapshot.** ~3,000 rows that move a
  handful of times a year each: a daily snapshot would be ~120× the rows for
  the same information. The arithmetic and the three things change-only
  storage has to get right are in the proposals doc.
- **The whole layer, every run.** There is nothing to gain from an
  incremental fetch at this size, and a whole class of "which rows changed?"
  bugs to avoid. What keeps the file small is the storage, not the fetch.
- **An extract is all-or-nothing.** A partial extract is indistinguishable
  from a registry that lost those records, and the merge would close their
  intervals as removals. A batch that cannot be read fails the run, and the
  merge additionally refuses an extract more than 10% smaller than the last.
- **The version hash covers the raw attributes, not the mapped columns**, so
  a change in a column `fields.ts` never recognized still opens a version.
  It excludes `OBJECTID`, `GlobalID` and the Esri edit stamps, which a
  truncate-and-append republish rewrites for every row at once.
- **The registration number is the identity**, not the object id, which is
  stable only until the publisher rebuilds the layer. A record with no
  readable number, or the second of two sharing one, falls back to the object
  id; the `registration_id_share` and `unique_registration_ids` checks report
  how many are in that position.
- **Both sides are normalized the same way, and no further.** Spacing, case
  and punctuation are absorbed; a wrong digit or a dropped prefix is not.
  Looser matching belongs in analysis, where a bad guess can be seen and
  undone.
- **A separate command from the daily scrape.** The two fail independently: a
  municipal server that is down must not withhold a day of Airbnb calendars,
  which cannot be scraped after the fact.
- **No `impit`, no pacer.** This is a documented, public, unauthenticated
  REST API with no bot protection and no rate limit worth pacing against;
  `src/arcgis/README.md` covers the ways it can still mislead a client.

## Tests

```sh
pnpm test        # vitest
pnpm typecheck
```

No test touches the network: `extractRegistry` takes injected fetchers, and
the wire-protocol tests stub `fetch`. `test/store.test.ts` and
`test/joinViews.test.ts` run the merge and the views against a real DuckDB
file.

`test/store.test.ts` asserts that the `registration_key` SQL macro agrees
with `normalizeRegistrationId` case by case. That test is the join: if the
two implementations drift, listings stop matching their own registrations and
nothing else says so.
