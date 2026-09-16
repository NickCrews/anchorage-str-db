/**
 * Opening the database: reject an incompatible file, apply the migrations in
 * `../drizzle`, check the tables against `schema.ts`, recreate the views and
 * check them against `viewSchema.ts`.
 */

import { fileURLToPath } from 'node:url';

import { migrate } from '@duckdbfan/drizzle-duckdb';
import {
  getTableName,
  getViewName,
  getViewSelectedFields,
  type Column as SchemaColumn,
} from 'drizzle-orm';

import { tables, views } from './catalog.ts';
import { duckDbType } from './columns.ts';
import { Database } from './database.ts';
import { viewsSql } from './views.ts';

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
 * Open (or create) the database at `path`. Both the daily and registry runs
 * open it this way, so they see one schema.
 */
export async function connect(path: string): Promise<Database> {
  const db = await Database.open(path);
  try {
    await rejectUnknownTables(db);
    await migrate(db.orm, { migrationsFolder: MIGRATIONS_FOLDER });
    await rejectMismatchedTables(db);
    await db.run(viewsSql());
    await rejectMismatchedViews(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

const TABLE_NAMES: ReadonlySet<string> = new Set(tables.map(getTableName));

/**
 * Every table must be one `schema.ts` declares. A table from an older schema
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
  for (const table of tables) {
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

/**
 * Types as written and as `duckdb_columns()` reports them differ in case and
 * in quoting: a struct field named for a keyword comes back as
 * `STRUCT("type" VARCHAR, ...)`.
 */
const normalizeType = (type: string) => type.replaceAll('"', '').replace(/\s+/g, ' ').toUpperCase();

/**
 * Every view must match its declaration in `viewSchema.ts`, column for
 * column. The declarations are what a reader writes queries from — the viewer
 * builds every one of its queries out of them — so they have to describe the
 * view `viewsSql` just created. A mismatch is a change to `views.ts` that has
 * not been carried over, never anything about the file being opened.
 */
async function rejectMismatchedViews(db: Database): Promise<void> {
  const declared: ReadonlySet<string> = new Set<string>(views.map(getViewName));
  const undeclared = (
    await db.rows<{ view_name: string }>(
      'SELECT view_name FROM duckdb_views() ' +
        "WHERE database_name = current_database() AND schema_name = 'main' ORDER BY view_name",
    )
  )
    .map((row) => row.view_name)
    .filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(
      `this database has views \`viewSchema.ts\` does not declare: ` +
        `${undeclared.map((name) => `\`${name}\``).join(', ')}.`,
    );
  }

  for (const view of views) {
    const name = getViewName(view);
    const want = Object.values(getViewSelectedFields(view)) as SchemaColumn[];
    const have = await db.rows<Column>(COLUMNS_SQL, [name]);
    for (let index = 0; index < Math.max(want.length, have.length); index++) {
      const [w, h] = [want[index], have[index]];
      const declaredColumn = w === undefined ? 'nothing' : `${w.name} ${duckDbType(w)}`;
      const actualColumn = h === undefined ? 'nothing' : `${h.column_name} ${h.data_type}`;
      if (normalizeType(declaredColumn) !== normalizeType(actualColumn)) {
        throw new Error(
          `\`${name}\` column ${index + 1} is \`${actualColumn}\`, but \`viewSchema.ts\` ` +
            `declares \`${declaredColumn}\`.`,
        );
      }
    }
  }
}
