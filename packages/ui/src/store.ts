import {
  BaseRoomConfig,
  createRoomShellSlice,
  createRoomStore,
  LayoutConfig,
  persistSliceConfigs,
  type RoomShellSliceState,
} from '@sqlrooms/room-shell';
import { createWasmDuckDbConnector } from '@sqlrooms/duckdb';
import { LayoutDashboardIcon, ListIcon, MapIcon } from 'lucide-react';
import { z } from 'zod';
import { ListingsView } from './components/ListingsView';
import { MapView } from './components/MapView';
import { OverviewView } from './components/OverviewView';
import { createDataInitSlice, type DataInitSliceState } from './dataInitSlice';

export const RoomPanelTypes = z.enum([
  'overview',
  'listings',
  'map',
] as const);
export type RoomPanelTypes = z.infer<typeof RoomPanelTypes>;

/** App state: SQLRooms' room shell plus the data-attach slice. */
export type RoomState = RoomShellSliceState & DataInitSliceState;

export const { roomStore, useRoomStore } = createRoomStore<RoomState>(
  persistSliceConfigs(
    {
      name: 'anchorage-str-db-viewer-state-v3',
      sliceConfigSchemas: {
        room: BaseRoomConfig,
        layout: LayoutConfig,
      },
    },
    (set, get, store) => ({
      ...createRoomShellSlice({
        // `MapView` uses `ST_Point`, which needs the spatial extension. The
        // default connector accepts no initialization query.
        connector: createWasmDuckDbConnector({
          initializationQuery: 'LOAD spatial;',
        }),
        config: {
          title: 'Anchorage STR DB',
        },
        layout: {
          config: {
            id: 'main',
            type: 'tabs',
            children: [
              RoomPanelTypes.enum.overview,
              RoomPanelTypes.enum.map,
              RoomPanelTypes.enum.listings,
            ],
            activeTabIndex: 0,
            defaultSize: '100%',
          } satisfies LayoutConfig,
          panels: {
            [RoomPanelTypes.enum.overview]: {
              title: 'Overview',
              icon: LayoutDashboardIcon,
              component: OverviewView,
            },
            [RoomPanelTypes.enum.map]: {
              title: 'Map',
              icon: MapIcon,
              component: MapView,
            },
            [RoomPanelTypes.enum.listings]: {
              title: 'Listings',
              icon: ListIcon,
              component: ListingsView,
            },
          },
        },
      })(set, get, store),

      ...createDataInitSlice()(set, get, store),
    }),
  ),
);
