/** Column types shared by the per-source table files. */

import { duckDbList } from '@duckdbfan/drizzle-duckdb';
import { bigint, customType, date, timestamp } from 'drizzle-orm/pg-core';

/** A DuckDB `DATE`, read and written as `YYYY-MM-DD`. */
export const day = (name: string) => date(name, { mode: 'string' });

/** A naive UTC DuckDB `TIMESTAMP`, read and written as `YYYY-MM-DD HH:MM:SS`. */
export const naiveTimestamp = (name: string) => timestamp(name, { mode: 'string' });

export const id = (name: string) => bigint(name, { mode: 'bigint' });

export const varcharList = (name: string) => duckDbList<string>(name, 'VARCHAR');

/** A list of structs; `sqlType` is the full DuckDB type, e.g. `STRUCT(a VARCHAR)[]`. */
export function structList<T>(name: string, sqlType: string) {
  return customType<{ data: T[] }>({ dataType: () => sqlType })(name);
}
