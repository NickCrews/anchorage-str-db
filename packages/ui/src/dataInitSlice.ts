import { isWasmDuckDbConnector } from '@sqlrooms/duckdb';
import type { RoomShellSliceState } from '@sqlrooms/room-shell';
import type { StateCreator } from 'zustand';

import { attachSql } from './queries/lake';


const DB_FILE_URL = `${import.meta.env.BASE_URL}anchorage_str.duckdb`;
const DB_FILE_NAME = 'anchorage_str.duckdb';

export type DataInitSliceState = {
  dataInit: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string | null;
    /** Awaited by the room store once the DuckDB connector is ready. */
    initialize: () => Promise<void>;
  };
};

/**
 * Fetches `anchorage_str.duckdb`, which `vite.config.ts` serves from the
 * repo's `data/`, attaches it read-only, and creates a main-schema view for
 * each name in `LAKE_TABLES` (see `queries/lake.ts`).
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
              `The viewer serves data/anchorage_str.duckdb; run a scrape or ` +
              `download the latest-data release there first.`,
            );
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          await connector.getDb().registerFileBuffer(DB_FILE_NAME, bytes);
          for (const statement of attachSql(DB_FILE_NAME)) {
            await connector.execute(statement).result;
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
