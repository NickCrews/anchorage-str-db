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

import {
  getTableColumns,
  getViewSelectedFields,
  sql,
  type SQL,
  type SQLWrapper,
  type Table,
  type View,
} from 'drizzle-orm';
import {
  PgDialect,
  pgTable,
  QueryBuilder,
  type BuildAliasTable,
  type PgColumnBuilderBase,
  type PgTable,
} from 'drizzle-orm/pg-core';

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

/**
 * A table or view in a `FROM` or `JOIN` clause, optionally under an alias:
 * `from(listings, l)` is `"listings" "l"`.
 *
 * An `alias()` interpolates as the alias alone — that is what its columns
 * render against — so the relation it stands for has to be named here beside
 * it. Passing an alias of some other relation does not typecheck.
 */
export function from<TRelation extends PgTable | View, TAlias extends string>(
  relation: TRelation,
  aliased?: BuildAliasTable<TRelation, TAlias>,
): SQL {
  return aliased === undefined ? sql`${relation}` : sql`${relation} ${aliased as Table | View}`;
}

/**
 * A view's columns, to select or to build another view's columns from:
 * `qb.select({...columnsOf(listingsActive), extra})` is `SELECT l.*, extra`
 * with every column named.
 */
export function columnsOf<TView extends View>(view: TView): TView['_']['selectedFields'] {
  return getViewSelectedFields(view) as TView['_']['selectedFields'];
}

/**
 * The columns a subquery or CTE derives, for declaring what it returns when
 * that is not a relation's own column: `$with('activity', derived('activity',
 * {firstSeenDate: day('first_seen_date')}))`. A reference to one renders
 * qualified, as `"activity"."first_seen_date"`.
 */
export function derived<TColumns extends Record<string, PgColumnBuilderBase>>(
  name: string,
  columns: TColumns,
) {
  return getTableColumns(pgTable(name, columns));
}
