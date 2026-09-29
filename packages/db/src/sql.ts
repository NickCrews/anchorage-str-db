/**
 * Turning a Drizzle query into DuckDB SQL text, for a reader that has no
 * Drizzle driver of its own.
 *
 * The scraper runs queries through `Database.orm`, which speaks to
 * `@duckdb/node-api` directly. The browser viewer has DuckDB-WASM behind
 * SQLRooms, which takes a SQL string and nothing else. `toSql` is the join
 * between them: a query written against `schema.ts` and `viewSchema.ts`
 * renders to one string, values and all, that either side can run.
 *
 * Rendering is `drizzle-orm/pg-core`'s, which quotes identifiers and escapes
 * strings the way DuckDB reads them. Nothing here reaches a driver.
 */

import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

/**
 * Drizzle's query builder, which builds SQL without a connection: what every
 * query here is written with, whether a driver will run it (`Database.orm`)
 * or `toSql` will render it for one that takes strings.
 */
export const qb = new QueryBuilder();

/**
 * One SQL string, with every value inlined as a literal rather than left as a
 * placeholder: ``sql`... = ${term}` `` becomes `... = 'o''brien'`.
 */
export function toSql(query: SQLWrapper): string {
  return dialect.sqlToQuery(query.getSQL().inlineParams()).sql;
}
