import { isWasmDuckDbConnector } from '@sqlrooms/duckdb';
import type { RoomShellSliceState } from '@sqlrooms/room-shell';
import type { StateCreator } from 'zustand';
import { ESTIMATE_STATEMENTS } from './model/estimates';

/**
 * Tables and views from the attached database that are exposed in the main
 * schema. Read `calendar_current` rather than `airbnb_calendar_status` for
 * current availability.
 */
export const LAKE_TABLES = [
  'listings',
  'listings_active',
  'listings_active_with_host',
  'hosts',
  'host_listing_portfolios',
  'airbnb_listing_observations',
  'airbnb_listing_photos',
  'listing_photos_current',
  'airbnb_listing_first_reviews',
  'airbnb_calendar_status',
  'calendar_current',
  'airbnb_scrape_runs',
  'muni_str_registration_observations',
  'muni_license_page_reads',
  'muni_str_registry_runs',
  'latest_registry_date',
  'source_freshness',
  'registrations',
  'registrations_active',
  'listings_active_with_registration',
  'property_parcels',
] as const;

/**
 * Whether this page builds the story's `est_*` tables. A page whose `<html>`
 * carries `data-skip-estimates` reads only the attached database.
 */
const BUILD_ESTIMATES =
  typeof document === 'undefined' || !('skipEstimates' in document.documentElement.dataset);

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
 * Fetches `anchorage_str.duckdb`, which `vite.config.ts` serves from the
 * repo's `data/`, attaches it read-only, creates a main-schema view for
 * each name in `LAKE_TABLES`, then builds the story's `est_*` tables
 * (`model/estimates.ts`) in memory unless the page skips them.
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
          await connector.execute(
            `ATTACH '${DB_FILE_NAME}' AS ${ATTACHED_SCHEMA} (READ_ONLY)`,
          ).result;

          for (const table of LAKE_TABLES) {
            await connector.execute(
              `CREATE OR REPLACE VIEW ${table} AS SELECT * FROM ${ATTACHED_SCHEMA}.${table}`,
            ).result;
          }

          // A database whose last parcel scrape predates the owner columns
          // gets them as NULLs, so the owner chapters show no matches
          // instead of the page failing to load.
          const ownerColumns = await connector.query(
            `SELECT count(*)::INT AS n FROM duckdb_columns()
             WHERE database_name = '${ATTACHED_SCHEMA}' AND table_name = 'property_parcels' AND column_name = 'owner_name'`,
          );
          if (Number(ownerColumns.getChild('n')?.get(0)) === 0) {
            await connector.execute(
              `CREATE OR REPLACE VIEW property_parcels AS SELECT *,
                 NULL::VARCHAR AS owner_name, NULL::VARCHAR AS owner_address, NULL::VARCHAR AS owner_city,
                 NULL::VARCHAR AS owner_state, NULL::VARCHAR AS owner_zip,
                 NULL::VARCHAR AS exemption_types_all, NULL::DOUBLE AS appraised_total_value
               FROM ${ATTACHED_SCHEMA}.property_parcels`,
            ).result;
          }

          for (const [table, sql] of BUILD_ESTIMATES ? ESTIMATE_STATEMENTS : []) {
            try {
              await connector.execute(sql).result;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(`Could not build ${table}: ${message}`);
            }
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
