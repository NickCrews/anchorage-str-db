import { isWasmDuckDbConnector } from '@sqlrooms/duckdb';
import type { RoomShellSliceState } from '@sqlrooms/room-shell';
import type { StateCreator } from 'zustand';

/**
 * Tables and views from the attached database that are exposed in the main
 * schema. Read `calendar_current` rather than `calendar_status` for current
 * availability.
 */
export const LAKE_TABLES = [
  'listings',
  'listings_current',
  'listings_current_with_host',
  'hosts',
  'host_portfolios',
  'listing_observations',
  'listing_photos',
  'listing_photos_current',
  'calendar_status',
  'calendar_current',
  'scrape_runs',
] as const;

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
