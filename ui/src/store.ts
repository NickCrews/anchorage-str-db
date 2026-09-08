import {
  BaseRoomConfig,
  createRoomShellSlice,
  createRoomStore,
  LayoutConfig,
  persistSliceConfigs,
  RoomShellSliceState,
} from '@sqlrooms/room-shell';
import { LayoutDashboardIcon, ListIcon } from 'lucide-react';
import { z } from 'zod';
import { ListingsView } from './components/ListingsView';
import { OverviewView } from './components/OverviewView';
import { createDataInitSlice, DataInitSliceState } from './dataInitSlice';

export const RoomPanelTypes = z.enum([
  'overview',
  'listings',
] as const);
export type RoomPanelTypes = z.infer<typeof RoomPanelTypes>;

/**
 * The whole app state: SQLRooms' room shell (layout, panels, DuckDB
 * connector), the SQL editor slice, and our own data-attach slice.
 */
export type RoomState = RoomShellSliceState &
  DataInitSliceState & {
  // Add your custom app state here
};

export const { roomStore, useRoomStore } = createRoomStore<RoomState>(
  persistSliceConfigs(
    {
      name: 'anchorage-str-db-viewer-state-v2',
      sliceConfigSchemas: {
        room: BaseRoomConfig,
        layout: LayoutConfig,
      },
    },
    (set, get, store) => ({
      ...createRoomShellSlice({
        config: {
          title: 'Anchorage STR DB',
        },
        layout: {
          config: {
            id: 'main',
            type: 'tabs',
            children: [
              RoomPanelTypes.enum.overview,
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
