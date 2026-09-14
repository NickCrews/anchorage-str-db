/**
 * A thin wrapper over one DuckDB connection, with a Drizzle instance on the
 * same connection so both take part in `transaction`.
 *
 * Reads use DuckDB's JSON conversion, which returns a `DATE` as
 * `"2026-09-11"` and a `BIGINT` as a decimal string.
 */

import {
  DuckDBInstance,
  DuckDBTypeId,
  dateValue,
  listValue,
  structValue,
  timestampValue,
  type DuckDBAppender,
  type DuckDBConnection,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';
import { drizzle, type DuckDBDatabase } from '@duckdbfan/drizzle-duckdb';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { epochDays } from '@anchorage-str-db/utils/dates';

import * as schema from './schema.ts';

type Params = DuckDBValue[];

export type Orm = DuckDBDatabase<typeof schema>;

export class Database {
  readonly #connection: DuckDBConnection;
  /** Drizzle over the same connection, for queries built from `schema.ts`. */
  readonly orm: Orm;

  constructor(connection: DuckDBConnection) {
    this.#connection = connection;
    this.orm = drizzle(connection, { schema });
  }

  static async open(path: string): Promise<Database> {
    const instance = await DuckDBInstance.create(path);
    return new Database(await instance.connect());
  }

  async run(sql: string, params: Params = [], types?: DuckDBType[]): Promise<void> {
    await this.#connection.run(sql, params, types);
  }

  /** Every row, as plain JSON-shaped objects. */
  async rows<T = Record<string, unknown>>(sql: string, params: Params = []): Promise<T[]> {
    const reader = await this.#connection.runAndReadAll(sql, params);
    return reader.getRowObjectsJson() as T[];
  }

  /** The first column of the first row, or undefined if there were no rows. */
  async value(sql: string, params: Params = []): Promise<unknown> {
    const reader = await this.#connection.runAndReadAll(sql, params);
    return reader.getRowsJson()[0]?.[0];
  }

  /** The first column of the first row as a number — a `count(*)`, usually. */
  async count(sql: string, params: Params = []): Promise<number> {
    return Number(await this.value(sql, params));
  }

  appender(table: string): Promise<DuckDBAppender> {
    return this.#connection.createAppender(table);
  }

  /**
   * Bulk-insert rows through DuckDB's appender, which is far faster than
   * `INSERT` for the ~950k calendar nights a run stages.
   *
   * Values are written in `table`'s declared column order and converted to
   * each column's DuckDB type: `YYYY-MM-DD` strings for `DATE`, naive UTC
   * `YYYY-MM-DD HH:MM:SS` strings for `TIMESTAMP`, arrays for lists and
   * objects for structs.
   *
   * `into` names a temporary table to stage into instead. `columns` writes
   * only those columns, still in declared order, for a staging table that
   * holds just them.
   */
  async appendRows<T extends PgTable, K extends keyof T['$inferInsert'] = keyof T['$inferInsert']>(
    table: T,
    rows: readonly Pick<T['$inferInsert'], K>[],
    options: { into?: string; columns?: readonly K[] } = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    const into = options.into ?? getTableName(table);
    const keys = Object.keys(getTableColumns(table)).filter(
      (key) => options.columns === undefined || options.columns.includes(key as K),
    );
    const appender = await this.appender(into);
    if (appender.columnCount !== keys.length) {
      appender.closeSync();
      throw new Error(
        `\`${into}\` has ${appender.columnCount} columns; ${keys.length} are being appended`,
      );
    }
    const types = keys.map((_, index) => appender.columnType(index));
    const converters = types.map(converterFor);
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      for (let index = 0; index < keys.length; index++) {
        const value = record[keys[index]!];
        appender.appendValue(
          value === undefined || value === null ? null : converters[index]!(value),
          types[index],
        );
      }
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  }

  /**
   * Run `body` in a transaction, rolling back if it throws.
   *
   * DuckDB autocommits each statement otherwise, and nothing in the schema
   * marks a scrape date as partially written.
   */
  async transaction<T>(body: () => Promise<T>): Promise<T> {
    await this.run('BEGIN TRANSACTION');
    let result: T;
    try {
      result = await body();
    } catch (err) {
      await this.run('ROLLBACK');
      throw err;
    }
    await this.run('COMMIT');
    return result;
  }

  close(): void {
    this.#connection.closeSync();
  }
}

type Converter = (value: unknown) => DuckDBValue;

/** How to turn a non-null JS value into a value of `type`. */
function converterFor(type: DuckDBType): Converter {
  switch (type.typeId) {
    case DuckDBTypeId.DATE:
      return (value) => dateValue(epochDays(value as string));
    case DuckDBTypeId.TIMESTAMP:
      return (value) =>
        timestampValue(BigInt(Date.parse(`${(value as string).replace(' ', 'T')}Z`)) * 1000n);
    case DuckDBTypeId.LIST: {
      const item = nullable(converterFor(type.valueType));
      return (value) => listValue((value as unknown[]).map(item));
    }
    case DuckDBTypeId.STRUCT: {
      const entries = type.entryNames.map(
        (name, index) => [name, nullable(converterFor(type.entryTypes[index]!))] as const,
      );
      return (value) => {
        const record = value as Record<string, unknown>;
        return structValue(
          Object.fromEntries(entries.map(([name, convert]) => [name, convert(record[name])])),
        );
      };
    }
    default:
      return (value) => value as DuckDBValue;
  }
}

function nullable(convert: Converter): Converter {
  return (value) => (value === undefined || value === null ? null : convert(value));
}
