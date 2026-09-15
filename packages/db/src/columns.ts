/**
 * The column builders `schema.ts` and `viewSchema.ts` are declared with, and
 * the DuckDB types they stand for.
 *
 * Drizzle has no DuckDB dialect, so a column is a `drizzle-orm/pg-core`
 * builder whose SQL type DuckDB reads as its own: `bigint` is `BIGINT`,
 * `date` is `DATE`, `doublePrecision` is `DOUBLE`, `varchar` is `VARCHAR`.
 * A type with no pg equivalent is a `customType` naming the DuckDB type
 * outright.
 *
 * Nothing here reaches a driver. The import below is
 * `@duckdbfan/drizzle-duckdb`'s browser-safe entry point rather than its
 * root, which loads `@duckdb/node-api`; that is what lets the viewer import
 * the same schema the scraper writes through. See the README.
 */

import { duckDbList } from '@duckdbfan/drizzle-duckdb/helpers';
import { bigint, customType, date, timestamp } from 'drizzle-orm/pg-core';

/**
 * Each helper takes its column name as a literal type, so a row type built
 * from the columns (see `rows.ts`) is keyed by the real column names.
 */

/** A DuckDB `DATE`, read and written as `YYYY-MM-DD`. */
export const day = <T extends string>(name: T) => date(name, { mode: 'string' });

/** A naive UTC DuckDB `TIMESTAMP`, read and written as `YYYY-MM-DD HH:MM:SS`. */
export const naiveTimestamp = <T extends string>(name: T) => timestamp(name, { mode: 'string' });

/** A DuckDB `BIGINT`: an Airbnb listing or user id. */
export const id = <T extends string>(name: T) => bigint(name, { mode: 'bigint' });

/** A DuckDB `VARCHAR[]`. */
export const varcharList = <T extends string>(name: T) => duckDbList<string>(name, 'VARCHAR');

/**
 * A list of structs; `sqlType` is the full DuckDB type, e.g. `STRUCT(a VARCHAR)[]`.
 * Curried, so the row type is named explicitly and the column name still
 * comes through as a literal: `structList<Row>(TYPE)('column')`.
 */
export function structList<TData>(sqlType: string) {
  return <TName extends string>(name: TName) =>
    customType<{ data: TData[] }>({ dataType: () => sqlType })(name);
}

/**
 * A DuckDB `HUGEINT`, which is what `sum()` returns. Only views have one, and
 * how it arrives in JS is the driver's business — a decimal string through the
 * Node API, an Arrow decimal in the browser — so no reader infers a type for it.
 */
export const hugeint = <T extends string>(name: T) =>
  customType<{ data: unknown }>({ dataType: () => 'HUGEINT' })(name);
