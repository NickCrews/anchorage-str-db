/**
 * A thin wrapper over a DuckDB connection.
 *
 * A copy of `packages/scraper/src/db.ts`, minus the pieces this package does
 * not use; see the note in `dates.ts` for why the two do not share a module.
 * Reads use DuckDB's JSON conversion, which returns a `DATE` as
 * `"2026-09-11"` and a `BIGINT` as a decimal string.
 */

import {
  DuckDBInstance,
  type DuckDBAppender,
  type DuckDBConnection,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';

type Params = DuckDBValue[];

export class Database {
  readonly #connection: DuckDBConnection;

  constructor(connection: DuckDBConnection) {
    this.#connection = connection;
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
   * Run `body` in a transaction, rolling back if it throws.
   *
   * DuckDB autocommits each statement otherwise, and a half-applied SCD2
   * merge — intervals closed, replacements not yet written — reads as a
   * registry that lost those records.
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

/** Append one row of already-typed values, then close the row. */
export function appendRow(
  appender: DuckDBAppender,
  types: readonly DuckDBType[],
  values: readonly DuckDBValue[],
): void {
  for (const [index, value] of values.entries()) appender.appendValue(value, types[index]);
  appender.endRow();
}
