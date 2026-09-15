import { tableNames, viewNames } from '@anchorage-str-db/db/catalog';
import { toSql } from '@anchorage-str-db/db/sql';
import { isWasmDuckDbConnector } from '@sqlrooms/duckdb';
import type { RoomShellSliceState } from '@sqlrooms/room-shell';
import { sql } from 'drizzle-orm';
import type { StateCreator } from 'zustand';

/**
 * Everything the attached database holds, exposed in the main schema: the
 * tables `@anchorage-str-db/db` declares and the views it builds over them.
 * The list is the schema's, not one kept here, so a view added to the database
 * shows up in the viewer without an edit.
 *
 * Read `calendar_current` rather than `airbnb_calendar_status` for current
 * availability, and `listings` rather than `airbnb_listing_observations` for
 * what a listing is now.
 */
export const LAKE_TABLES: readonly string[] = [...tableNames, ...viewNames];

const DB_FILE_URL = `${import.meta.env.BASE_URL}anchorage_str.duckdb`;
const DB_FILE_NAME = 'anchorage_str.duckdb';
const ATTACHED_SCHEMA = 'str';

export type DataInitSliceState = {
  dataInit: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string | null;
    /** Awaited by the room store once the DuckDB connector is ready. */
    initialize: () => Promise<void>;
  };
};

/**
 * Attaches `public/anchorage_str.duckdb` read-only and creates a main-schema
 * view for each name in `LAKE_TABLES`.
 */
export function createDataInitSlice(): StateCreator<
  RoomShellSliceState & DataInitSliceState,
  [],
  [],
  DataInitSliceState
> {
  return (set, get) => ({
    dataInit: {
      status: 'idle',
      error: null,
      async initialize() {
        set((s) => ({ dataInit: { ...s.dataInit, status: 'loading' } }));
        try {
          const connector = await get().db.getConnector();
          if (!isWasmDuckDbConnector(connector)) {
            throw new Error(
              'Expected the default in-browser (WASM) DuckDB connector.',
            );
          }

          const response = await fetch(DB_FILE_URL);
          if (!response.ok) {
            throw new Error(
              `Could not fetch ${DB_FILE_URL} (${response.status}). ` +
              `Copy data/anchorage_str.duckdb into packages/ui/public/ first.`,
            );
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          await connector.getDb().registerFileBuffer(DB_FILE_NAME, bytes);
          await connector.execute(
            `ATTACH '${DB_FILE_NAME}' AS ${ATTACHED_SCHEMA} (READ_ONLY)`,
          ).result;

          for (const table of LAKE_TABLES) {
            await connector.execute(
              toSql(sql`CREATE OR REPLACE VIEW ${sql.identifier(table)} AS
                SELECT * FROM ${sql.identifier(ATTACHED_SCHEMA)}.${sql.identifier(table)}`),
            ).result;
          }

          await get().db.refreshTableSchemas();
          set((s) => ({ dataInit: { ...s.dataInit, status: 'ready' } }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          set((s) => ({ dataInit: { ...s.dataInit, status: 'error', error: message } }));
          throw err;
        }
      },
    },
  });
}
