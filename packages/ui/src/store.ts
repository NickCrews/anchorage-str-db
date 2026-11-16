import {
  createRoomShellSlice,
  createRoomStore,
  type RoomShellSliceState,
} from '@sqlrooms/room-shell';
import { createWasmDuckDbConnector } from '@sqlrooms/duckdb';
import { createMosaicSlice, type MosaicSliceState } from '@sqlrooms/mosaic';
import { createDataInitSlice, type DataInitSliceState } from './dataInitSlice';

/**
 * App state: SQLRooms' room shell for its DuckDB connector, Mosaic for the
 * chapters' cross-filtering, and the data-attach slice.
 */
export type RoomState = RoomShellSliceState & MosaicSliceState & DataInitSliceState;

export const { roomStore, useRoomStore } = createRoomStore<RoomState>(
  (set, get, store) => ({
    ...createRoomShellSlice({
      // The maps use `ST_Point`, which needs the spatial extension. The
      // default connector accepts no initialization query.
      connector: createWasmDuckDbConnector({
        initializationQuery: 'LOAD spatial;',
      }),
      config: {
        title: 'Anchorage STR DB',
      },
    })(set, get, store),

    ...createMosaicSlice()(set, get, store),

    ...createDataInitSlice()(set, get, store),
  }),
);
