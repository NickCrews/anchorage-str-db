import { isWasmDuckDbConnector } from '@sqlrooms/duckdb';
import type { RoomShellSliceState } from '@sqlrooms/room-shell';
import type { StateCreator } from 'zustand';

/**
 * The tables (views, really) this app expects to exist in the main schema
 * once the database is attached — kept in one place so the rest of the app can
 * just reference them by name.
 */
export const LAKE_TABLES = [
  'listings',
  'listing_observations',
  'calendar_status',
  'scrape_runs',
] as const;

const DB_FILE_URL = `${import.meta.env.BASE_URL}anchorage_str.duckdb`;
const DB_FILE_NAME = 'anchorage_str.duckdb';
const ATTACHED_SCHEMA = 'str';

export type DataInitSliceState = {
  dataInit: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string | null;
    /**
     * Picked up automatically by the room store's init sequence (any
     * top-level slice with an `initialize()` gets awaited after the DuckDB
     * connector and any configured `dataSources` are ready) — see
     * `@sqlrooms/room-store`'s `createBaseRoomSlice`.
     */
    initialize: () => Promise<void>;
  };
};

/**
 * Attaches the pre-built `anchorage_str.duckdb` snapshot (served from
 * `public/`) into the in-browser DuckDB-WASM instance and creates
 * convenience views for its tables in the main schema, so the rest of the
 * app (SQL editor, data table, charts) can just query `listings`,
 * `calendar_status`, etc. directly.
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
              `Copy data/anchorage_str.duckdb into ui/public/ first.`,
            );
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          await connector.getDb().registerFileBuffer(DB_FILE_NAME, bytes);
          await connector.execute(
            `ATTACH '${DB_FILE_NAME}' AS ${ATTACHED_SCHEMA} (READ_ONLY)`,
          ).result;

          for (const table of LAKE_TABLES) {
            await connector.execute(
              `CREATE OR REPLACE VIEW ${table} AS SELECT * FROM ${ATTACHED_SCHEMA}.${table}`,
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
