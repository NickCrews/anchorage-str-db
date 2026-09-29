/**
 * Every query the viewer runs, run against a real database.
 *
 * The viewer's queries are built from the schema, so a renamed column is a
 * type error; but nothing else in the repo runs them, and the browser is the
 * first place a query that DuckDB rejects, or that emits columns under names
 * other than the ones the viewer reads rows by, would show up. So this builds
 * an empty database with `connect`, attaches it the way `dataInitSlice` does,
 * and runs each query in every variant its toggles and search box produce:
 *
 * - DuckDB has to bind it. An empty database is enough for that: names and
 *   types are resolved when the query is planned, not row by row.
 * - The columns it emits have to be the keys of its selection, in order,
 *   which is what `WasmSelection` assumes when it types the rows.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '@anchorage-str-db/db/connect';
import { toSql } from '@anchorage-str-db/db/sql';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { SQLWrapper } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CUTOFFS,
  DISTRIBUTION_FIELDS,
  DISTRIBUTION_QUERY,
  summaryFields,
  summaryQuery,
  trendFields,
  trendQuery,
} from '../src/queries/hostConcentration.ts';
import { HOST_FIELDS, hostsTableQuery, SCOPES as HOST_SCOPES } from '../src/queries/hosts.ts';
import { attachSql } from '../src/queries/lake.ts';
import { ALL_STATUSES, LISTING_FIELDS, listingsTableQuery } from '../src/queries/listings.ts';
import { AIRBNB_RENTAL_FIELDS, RENTALS_QUERY } from '../src/queries/map.ts';
import {
  AVAILABILITY_FIELDS,
  AVAILABILITY_QUERY,
  BEDROOM_MIX_FIELDS,
  BEDROOM_MIX_QUERY,
  KPI_FIELDS,
  KPI_QUERY,
  LISTING_AGE_FIELDS,
  LISTING_AGE_QUERY,
  STR_TREND_FIELDS,
  STR_TREND_QUERY,
} from '../src/queries/overview.ts';
import {
  BY_LISTING_TYPE_FIELDS,
  BY_LISTING_TYPE_QUERY,
  COUNCIL_FIELDS,
  COUNCIL_QUERY,
  SUMMARY_FIELDS,
  SUMMARY_QUERY,
} from '../src/queries/registrationCard.ts';
import {
  REGISTRATION_FIELDS,
  registrationsTableQuery,
  SCOPES as REGISTRATION_SCOPES,
} from '../src/queries/registrations.ts';
import { REGISTRATION_STATUSES } from '../src/registrationStatus.ts';

/** A search box's text with a quote and LIKE wildcards in it, to exercise escaping. */
const SEARCH = "o'brien 100%_";

const keys = (fields: object) => Object.keys(fields);

/** Each query the viewer runs, and the columns it has to emit. */
const QUERIES: ReadonlyArray<{ name: string; query: SQLWrapper; columns: string[] }> = [
  { name: 'overview kpis', query: KPI_QUERY, columns: keys(KPI_FIELDS) },
  { name: 'overview availability', query: AVAILABILITY_QUERY, columns: keys(AVAILABILITY_FIELDS) },
  { name: 'overview listings trend', query: STR_TREND_QUERY, columns: keys(STR_TREND_FIELDS) },
  { name: 'overview listing age', query: LISTING_AGE_QUERY, columns: keys(LISTING_AGE_FIELDS) },
  { name: 'overview bedroom mix', query: BEDROOM_MIX_QUERY, columns: keys(BEDROOM_MIX_FIELDS) },
  { name: 'registration summary', query: SUMMARY_QUERY, columns: keys(SUMMARY_FIELDS) },
  {
    name: 'registration by listing type',
    query: BY_LISTING_TYPE_QUERY,
    columns: keys(BY_LISTING_TYPE_FIELDS),
  },
  { name: 'registration councils', query: COUNCIL_QUERY, columns: keys(COUNCIL_FIELDS) },
  ...CUTOFFS.flatMap((cutoff) => [
    {
      name: `host concentration summary, ${cutoff}+`,
      query: summaryQuery(cutoff),
      columns: keys(summaryFields(cutoff)),
    },
    {
      name: `host concentration trend, ${cutoff}+`,
      query: trendQuery(cutoff),
      columns: keys(trendFields(cutoff)),
    },
  ]),
  {
    name: 'host concentration distribution',
    query: DISTRIBUTION_QUERY,
    columns: keys(DISTRIBUTION_FIELDS),
  },
  ...(Object.keys(HOST_SCOPES) as (keyof typeof HOST_SCOPES)[]).flatMap((scope) =>
    ['', SEARCH].map((search) => ({
      name: `hosts, ${scope}${search ? ', searched' : ''}`,
      query: hostsTableQuery(scope, search),
      // `search_text` is for filtering only and is dropped with `EXCLUDE`.
      columns: keys(HOST_FIELDS).filter((key) => key !== 'search_text'),
    })),
  ),
  ...(Object.keys(REGISTRATION_SCOPES) as (keyof typeof REGISTRATION_SCOPES)[]).flatMap((scope) =>
    ['', SEARCH].map((search) => ({
      name: `registrations, ${scope}${search ? ', searched' : ''}`,
      query: registrationsTableQuery(scope, search),
      columns: keys(REGISTRATION_FIELDS),
    })),
  ),
  ...([ALL_STATUSES, ...REGISTRATION_STATUSES] as const).flatMap((status) =>
    ['', SEARCH].map((search) => ({
      name: `listings, ${status}${search ? ', searched' : ''}`,
      query: listingsTableQuery(search, status),
      columns: keys(LISTING_FIELDS),
    })),
  ),
  { name: 'map rentals', query: RENTALS_QUERY, columns: keys(AIRBNB_RENTAL_FIELDS) },
];

let dir: string;
let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anchorage-str-ui-'));
  const file = join(dir, 'anchorage_str.duckdb');
  (await connect(file)).close();

  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  // The map's `ST_Point`; `store.ts` loads the same extension in the browser.
  await connection.run('INSTALL spatial; LOAD spatial;');
  for (const statement of attachSql(file)) await connection.run(statement);
});

afterAll(async () => {
  connection?.closeSync();
  instance?.closeSync();
  await rm(dir, { recursive: true, force: true });
});

describe('viewer queries', () => {
  it.each(QUERIES)('$name', async ({ query, columns }) => {
    const reader = await connection.runAndReadAll(toSql(query));
    expect(reader.columnNames()).toEqual(columns);
  });
});
