# Anchorage STR DB viewer

A [SQLRooms](https://sqlrooms.org) app for browsing `anchorage_str.duckdb`.
Queries run in the browser with
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview); there is no server.

- **Overview**: active listings, booked tonight, distinct STRs over the last
  year, current Muni registrations and how many listings show one,
  registration status by room type and community council, host
  concentration, near-term booked/vacant nights, monthly distinct-STR trend,
  current listings by year first available, and bedroom mix.
- **Map**: every current Airbnb listing plus every current registration no
  Airbnb listing cites, colored by registration status or price. A listing is
  placed at its registration's geocoded license address when it has one,
  otherwise at Airbnb's pin; filled dots are known locations and rings are
  Airbnb's approximate pins.
- **Listings**: a searchable table of current listings with a cover-photo
  thumbnail, room type, their latest rating, review count and price quote,
  host name, years hosting, the host's portfolio size, registration status
  with the registered address and parcel, and estimated first-available date.
  Filters by registration status.
- **Hosts**: a searchable table of Airbnb hosts with current listings: listing
  count, distinct registration numbers, listings per registration status, and
  the business names on the registrations their listings cite. Filters to
  hosts with 2+ listings or with listings that show no number.
- **Registrations**: a searchable table of the Muni's STR registrations with
  their license page description and the number of current Airbnb listings
  citing each. Filters to current, current with no Airbnb listing, or no
  longer published.

Registration status compares the number a listing page shows with the
registry: `Registered`, `Registration not current` (no longer published),
`Number not in registry` (includes numbers issued since the Muni's last
publish), or `No number shown`.

## Running locally

The viewer reads the repo's `data/anchorage_str.duckdb`. From the repo root:

```sh
# Only without a local database: download the latest published one.
mkdir -p data
gh release download latest-data --repo NickCrews/anchorage-str-db -O data/anchorage_str.duckdb

pnpm --filter @anchorage-str-db/ui dev
```

Open the printed `localhost` URL. After a scrape, reload the page to see the
new data.

## Data loading

The `serveDatabase` plugin in [`vite.config.ts`](vite.config.ts) serves
`data/anchorage_str.duckdb` at `/anchorage_str.duckdb` in dev and copies it
into `dist/` on build; a build without it fails. On startup,
[`src/dataInitSlice.ts`](src/dataInitSlice.ts) fetches that file, attaches it
read-only, and creates a view in the main schema for every table and view
`@anchorage-str-db/db` declares, so the SQL editor and the schema tree show
the whole database.

## Queries

Queries are written against the Drizzle schema in `@anchorage-str-db/db`
rather than as SQL strings: `schema.ts` for the tables, `viewSchema.ts` for
the views, and `toSql` to render one query to the string SQLRooms runs.

Every query here is built with Drizzle's query builder, which builds SQL
without a connection. So each `select`, `join`, `where` and `group by` is
checked against the relation it names, and the row type follows the
selection:

```ts
import type {WasmSelection} from '@anchorage-str-db/db/rows';
import {toSql} from '@anchorage-str-db/db/sql';
import {hosts, listingsCurrent} from '@anchorage-str-db/db/viewSchema';
import {eq, sql} from 'drizzle-orm';
import {QueryBuilder} from 'drizzle-orm/pg-core';

const qb = new QueryBuilder();

// The keys are the column names the query emits, which is what the browser
// reads the Arrow columns by: a plain column keeps its own name, and a `sql`
// expression takes the alias `.as()` gives it.
const fields = {
  host_name: hosts.name,
  listings: sql<number>`count(*)::INT`.as('listings'),
};

const query = qb
  .select(fields)
  .from(listingsCurrent)
  .innerJoin(hosts, eq(hosts.hostId, listingsCurrent.hostId))
  .groupBy(hosts.name);

toSql(query);
type Row = WasmSelection<typeof fields>; // { host_name: string | null; listings: number }
```

### DuckDB syntax inside a built query

Drizzle speaks the Postgres dialect and has no notion of `FILTER`,
`GROUP BY ALL`, `EXCLUDE`, `QUALIFY`, `ST_Point` or DuckDB's list and struct
syntax. That is a reason to drop to a `sql` fragment for the part that needs
it, not to write the query as a string: a fragment can go anywhere the
builder takes an expression, and everything around it stays checked.

```ts
qb.select({
    // A whole expression, under the name it is read by.
    booked: sql<number>`count(*) FILTER (WHERE NOT ${calendarCurrent.available})::INT`.as('booked'),
  })
  .from(calendarCurrent)
  .where(sql`${calendarCurrent.nightDate} BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL 90 DAY`)
  .groupBy(sql`ALL`);
```

The same goes for a relation the builder cannot express. A subquery built
with `.as(name)` carries its columns — `latest.listingsLive` below is
checked, and so is anything that reads it later — and `qb.$with(name, columns)`
does the same for a CTE whose body has to be raw DuckDB SQL:

```ts
const latest = qb.select().from(hostPortfolios).where(...).as('latest');
const recent = qb
  .$with('recent', {listingId: bigint('listing_id'), scrapeDate: day('scrape_date')})
  .as(sql`SELECT listing_id, scrape_date FROM ${from(airbnbListingObservations)}
          QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY scrape_date DESC) = 1`);
```

One thing has no seam: Drizzle's `unionAll` takes the selects of a connected
database, not a `QueryBuilder`'s, so the map's two halves are joined in a
`sql` template around two built selects. Each half is still a built query.

Either way a renamed column breaks the build here instead of returning nothing
at runtime, and values interpolated into a query (a search box's text) are
escaped by Drizzle rather than by hand. Columns a query invents — a `status` a
`CASE` derives, a count it names — are named once, where they are computed,
and read from the subquery that computed them after that.
`WasmRow<typeof someView>` is a row of a relation as DuckDB-WASM delivers it,
which is not how the scraper's driver delivers the same columns; see
[CONTRIBUTING.md](../../CONTRIBUTING.md#reading-the-database-from-the-browser).
