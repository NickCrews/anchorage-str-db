/**
 * What a row of a table or view looks like in JavaScript — which depends on
 * who read it.
 *
 * The scraper reads through `@duckdb/node-api`'s JSON conversion, which hands
 * back a `DATE` as `'2026-09-11'` and a `BIGINT` as a decimal string. The
 * viewer reads through DuckDB-WASM, which hands back Arrow: the same `DATE` is
 * epoch milliseconds and the same `BIGINT` is a `bigint`. The columns are the
 * same either way, so the two mappings sit here beside each other rather than
 * being written out again at each call site.
 *
 * Both are keyed by database column name rather than by the Drizzle property
 * name, because that is what a raw `SELECT` returns:
 *
 * ```ts
 * type Row = Pick<WasmRow<typeof listings>, 'name' | 'first_seen_date'>;
 * //   { name: string | null; first_seen_date: number | null }
 * ```
 */

import type { Column, Table, View } from 'drizzle-orm';

type Columns = Record<string, Column>;

/** A table's columns, or a view's; both are keyed by Drizzle property name. */
type ColumnsOf<TRelation extends Table | View> = TRelation extends Table
  ? TRelation['_']['columns']
  : TRelation extends View
    ? TRelation['_']['selectedFields'] extends Columns
      ? TRelation['_']['selectedFields']
      : never
    : never;

/** A column's value, NULL included unless the column forbids it. */
type Nullable<TColumn extends Column, TValue> = TColumn['_']['notNull'] extends true
  ? TValue
  : TValue | null;

/**
 * `@duckdb/node-api`'s JSON conversion: a `DATE` or `TIMESTAMP` is the string
 * the column is declared as, and a `BIGINT` is a decimal string, JSON having
 * no 64-bit integer.
 */
type NodeValue<TColumn extends Column> = Nullable<
  TColumn,
  TColumn['_']['columnType'] extends 'PgBigInt53' | 'PgBigInt64'
    ? string
    : TColumn['_']['data']
>;

/**
 * Arrow, as DuckDB-WASM delivers it:
 *
 * - a `DATE` or `TIMESTAMP` is epoch milliseconds, not a string;
 * - a `BIGINT` is a `bigint`;
 * - a `LIST` is an Arrow `Vector` rather than an array, so it is left
 *   `unknown`: index into it in SQL (`photo_urls[1]`) instead of in JS.
 */
type WasmValue<TColumn extends Column> = Nullable<
  TColumn,
  TColumn['_']['columnType'] extends 'PgDate' | 'PgDateString' | 'PgTimestamp' | 'PgTimestampString'
    ? number
    : TColumn['_']['columnType'] extends 'PgBigInt53' | 'PgBigInt64'
      ? bigint
      : TColumn['_']['data'] extends readonly unknown[]
        ? unknown
        : TColumn['_']['data']
>;

/** A row of `relation` as `Database.rows()` returns it to the scraper. */
export type NodeRow<TRelation extends Table | View> = {
  [K in keyof ColumnsOf<TRelation> as ColumnsOf<TRelation>[K]['_']['name']]: NodeValue<
    ColumnsOf<TRelation>[K]
  >;
};

/** A row of `relation` as SQLRooms' `useSql()` returns it to the viewer. */
export type WasmRow<TRelation extends Table | View> = {
  [K in keyof ColumnsOf<TRelation> as ColumnsOf<TRelation>[K]['_']['name']]: WasmValue<
    ColumnsOf<TRelation>[K]
  >;
};
