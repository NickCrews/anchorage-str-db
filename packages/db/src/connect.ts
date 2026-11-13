/**
 * Opening the database: reject an incompatible file, apply the migrations in
 * `../drizzle`, check the tables against `schema/`, and recreate the views.
 */

import { fileURLToPath } from 'node:url';

import { migrate } from '@duckdbfan/drizzle-duckdb';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import { Database } from './database.ts';
import * as schema from './schema/index.ts';
import { viewsSql } from './views/index.ts';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Raised for a database whose schema this code cannot read. */
export class LegacySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacySchemaError';
  }
}

const NO_MIGRATION =
  "There is no migration: see CONTRIBUTING.md, 'When the published database has an incompatible schema'.";

/**
 * Open (or create) the database at `path`: apply the migrations it has not
 * recorded, reject tables that differ from the schema, and recreate the views.
 */
export async function connect(path: string): Promise<Database> {
  const db = await Database.open(path);
  try {
    await rejectUnknownTables(db);
    await migrate(db.orm, { migrationsFolder: MIGRATIONS_FOLDER });
    await rejectMismatchedTables(db);
    await db.run(viewsSql());
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

const TABLE_NAMES: ReadonlySet<string> = new Set(
  Object.values(schema).flatMap((table) => (is(table, PgTable) ? [getTableName(table)] : [])),
);

/**
 * Every table must be one `schema/` declares. A table from an older schema
 * (tables named without their source prefix, or `listings` as a table rather
 * than a view) means the file predates the migrations, and migrating it would
 * add empty tables beside the old data.
 */
async function rejectUnknownTables(db: Database): Promise<void> {
  const unknown = (
    await db.rows<{ table_name: string }>(
      'SELECT table_name FROM duckdb_tables() ' +
        "WHERE database_name = current_database() AND schema_name = 'main' ORDER BY table_name",
    )
  )
    .map((row) => row.table_name)
    .filter((name) => !TABLE_NAMES.has(name));
  if (unknown.length > 0) {
    throw new LegacySchemaError(
      `this database has tables the schema does not declare: ` +
        `${unknown.map((name) => `\`${name}\``).join(', ')}. ${NO_MIGRATION}`,
    );
  }
}

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
}

const COLUMNS_SQL =
  'SELECT column_name, data_type, is_nullable FROM duckdb_columns() ' +
  "WHERE database_name = current_database() AND schema_name = 'main' AND table_name = ? " +
  'ORDER BY column_index';

let expectedDatabase: Promise<Database> | undefined;

/** An in-memory database built from the migrations alone: what every table should be. */
function expected(): Promise<Database> {
  expectedDatabase ??= (async () => {
    const db = await Database.open(':memory:');
    await migrate(db.orm, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  })();
  return expectedDatabase;
}

/**
 * Every table must match what the migrations create, column for column: the
 * baseline migration skips tables that already exist, and `appendRows`
 * writes by position into the columns it finds.
 */
async function rejectMismatchedTables(db: Database): Promise<void> {
  const reference = await expected();
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const name = getTableName(table);
    const want = await reference.rows<Column>(COLUMNS_SQL, [name]);
    const have = await db.rows<Column>(COLUMNS_SQL, [name]);
    const describe = (column: Column | undefined) =>
      column === undefined
        ? 'nothing'
        : `${column.column_name} ${column.data_type}${column.is_nullable ? '' : ' NOT NULL'}`;
    for (let index = 0; index < Math.max(want.length, have.length); index++) {
      const [w, h] = [describe(want[index]), describe(have[index])];
      if (w !== h) {
        throw new LegacySchemaError(
          `\`${name}\` column ${index + 1} is \`${h}\`, not \`${w}\`. ${NO_MIGRATION}`,
        );
      }
    }
  }
}
