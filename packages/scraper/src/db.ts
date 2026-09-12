/**
 * A thin wrapper over DuckDB's connection, so the rest of the package can
 * ask for a count or a list of rows without thinking about chunks, readers
 * or `DuckDBValue` wrappers.
 *
 * Reads come back through DuckDB's JSON converter, which renders a `DATE` as
 * `"2026-09-11"` and a `BIGINT` as a decimal string. Both are exactly what
 * this package uses natively (see `dates.ts`), so no reader ever has to
 * unwrap a value object.
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
   * Group writes into one all-or-nothing unit.
   *
   * DuckDB autocommits every statement, so without this each statement a run
   * issues is independently durable and a crash part-way leaves a
   * half-written scrape date on disk — listings recorded but no calendar, or
   * the reverse.
   *
   * A scrape date is the unit that carries meaning here: every table is
   * keyed by it and the quality gate judges one. A partially written day
   * isn't a smaller true thing, it's a false one, because nothing in the
   * schema marks it as partial.
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
