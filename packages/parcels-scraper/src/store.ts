/**
 * Reads from anchorage-property's published database, and writes for the
 * parcel scrape. The tables are defined in `@anchorage-str-db/db/schema`.
 */

import type { Database } from '@anchorage-str-db/db/database';
import { propertyParcelScrapeRuns } from '@anchorage-str-db/db/schema';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

/** The name the source is attached under while it is read. */
const SOURCE_ALIAS = 'anchorage_property';

/** The source table: one row per parcel, its current state. */
export const SOURCE_TABLE = 'parcels_current';

/**
 * The columns read from `parcels_current`, with the type each is cast to:
 * those of `property_parcels`, in its order, without `scrape_date`.
 * `replaceParcels` names every column, so `scrape_date` sitting between
 * `valid_from` and the owner columns does not matter.
 */
const SOURCE_COLUMNS = [
  ['parcel_id', 'VARCHAR'],
  ['parcel_address', 'VARCHAR'],
  ['property_type', 'VARCHAR'],
  ['total_living_units', 'INTEGER'],
  ['land_use', 'VARCHAR'],
  ['zoning_district', 'VARCHAR'],
  ['centroid_lat', 'DOUBLE'],
  ['centroid_lon', 'DOUBLE'],
  ['valid_from', 'TIMESTAMP'],
  ['owner_name', 'VARCHAR'],
  ['owner_address', 'VARCHAR'],
  ['owner_city', 'VARCHAR'],
  ['owner_state', 'VARCHAR'],
  ['owner_zip', 'VARCHAR'],
  ['exemption_types_all', 'VARCHAR'],
  ['appraised_total_value', 'DOUBLE'],
] as const;

/** The temporary table a read stages the source's parcels in. */
export const STAGED_PARCELS = 'stg_property_parcels';

export interface IngestRun {
  /** anchorage-property's `run_id`: '2026-11-13-d1a8fba8'. */
  runId: string;
  /** Naive UTC, `YYYY-MM-DD HH:MM:SS`. */
  startedAt: string;
}

export interface SourceRead {
  /** Columns of `property_parcels` the source's `parcels_current` lacks; all of them when it has no such table. */
  missingColumns: string[];
  /** The source's newest successful ingest run, or null when it records none. */
  newestIngestRun: IngestRun | null;
}

/**
 * Attach the source read-only, copy its parcels into `STAGED_PARCELS` (when
 * it has every column), read its newest ingest run, and detach it.
 * `url` is an https URL or a local path.
 */
export async function readSource(db: Database, url: string): Promise<SourceRead> {
  await db.run(`ATTACH '${url.replaceAll("'", "''")}' AS ${SOURCE_ALIAS} (READ_ONLY)`);
  try {
    const present = new Set(
      (
        await db.rows<{ column_name: string }>(
          'SELECT column_name FROM duckdb_columns() ' +
            "WHERE database_name = ? AND schema_name = 'main' AND table_name = ?",
          [SOURCE_ALIAS, SOURCE_TABLE],
        )
      ).map((row) => row.column_name),
    );
    const missingColumns = SOURCE_COLUMNS.map(([name]) => name).filter((name) => !present.has(name));

    await db.run(`DROP TABLE IF EXISTS ${STAGED_PARCELS}`);
    if (missingColumns.length === 0) {
      await db.run(
        `CREATE TEMP TABLE ${STAGED_PARCELS} AS SELECT ` +
          SOURCE_COLUMNS.map(([name, type]) => `CAST(${name} AS ${type}) AS ${name}`).join(', ') +
          ` FROM ${SOURCE_ALIAS}.main.${SOURCE_TABLE}`,
      );
    }

    return { missingColumns, newestIngestRun: await newestIngestRun(db) };
  } finally {
    await db.run(`DETACH ${SOURCE_ALIAS}`);
  }
}

/** The source's newest ingest run with status 'success', from its `ingest_runs`. */
async function newestIngestRun(db: Database): Promise<IngestRun | null> {
  const tables = await db.count(
    'SELECT count(*) FROM duckdb_tables() ' +
      "WHERE database_name = ? AND schema_name = 'main' AND table_name = 'ingest_runs'",
    [SOURCE_ALIAS],
  );
  if (!tables) return null;
  const [run] = await db.rows<{ run_id: string; started_at: string }>(
    "SELECT run_id, strftime(started_at, '%Y-%m-%d %H:%M:%S') AS started_at " +
      `FROM ${SOURCE_ALIAS}.main.ingest_runs WHERE status = 'success' ` +
      'ORDER BY started_at DESC LIMIT 1',
  );
  return run ? { runId: run.run_id, startedAt: run.started_at } : null;
}

/**
 * Replace every row of `property_parcels` with the staged parcels. Returns
 * how many were written.
 *
 * The table is dropped and recreated from its own DDL rather than emptied
 * with DELETE: DuckDB's primary-key index keeps the deleted keys' blocks, so
 * a DELETE of every row grew the file by about 2.5 MB a scrape.
 */
export async function replaceParcels(db: Database, scrapeDate: IsoDate): Promise<number> {
  const columns = [...SOURCE_COLUMNS.map(([name]) => name), 'scrape_date'].join(', ');
  const ddl = await db.value(
    'SELECT sql FROM duckdb_tables() ' +
      "WHERE database_name = current_database() AND schema_name = 'main' AND table_name = 'property_parcels'",
  );
  if (typeof ddl !== 'string') throw new Error('property_parcels does not exist');
  await db.run('DROP TABLE property_parcels');
  await db.run(ddl);
  await db.run(
    `INSERT INTO property_parcels (${columns}) ` +
      `SELECT *, CAST(? AS DATE) FROM ${STAGED_PARCELS}`,
    [scrapeDate],
  );
  return db.count('SELECT count(*) FROM property_parcels');
}

/** Every column, so a caller cannot leave one out by omission. */
export type RunRow = Required<typeof propertyParcelScrapeRuns.$inferInsert>;

export async function logRun(db: Database, run: RunRow): Promise<void> {
  await db.orm.insert(propertyParcelScrapeRuns).values(run);
}
