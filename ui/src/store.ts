import {
  BaseRoomConfig,
  createRoomShellSlice,
  createRoomStore,
  LayoutConfig,
  persistSliceConfigs,
  RoomShellSliceState,
} from '@sqlrooms/room-shell';
import {
  createDefaultSqlEditorConfig,
  createSqlEditorSlice,
  SqlEditorSliceConfig,
  SqlEditorSliceState,
} from '@sqlrooms/sql-editor';
import { LayoutDashboardIcon, ListIcon, TerminalIcon } from 'lucide-react';
import { z } from 'zod';
import { ListingsView } from './components/ListingsView';
import { OverviewView } from './components/OverviewView';
import { SqlView } from './components/SqlView';
import { createDataInitSlice, DataInitSliceState } from './dataInitSlice';
import { SEED_QUERIES } from './seedQueries';

export const RoomPanelTypes = z.enum([
  'overview',
  'listings',
  'sql',
] as const);
export type RoomPanelTypes = z.infer<typeof RoomPanelTypes>;

/**
 * The whole app state: SQLRooms' room shell (layout, panels, DuckDB
 * connector), the SQL editor slice, and our own data-attach slice.
 */
export type RoomState = RoomShellSliceState &
  SqlEditorSliceState &
  DataInitSliceState & {
  // Add your custom app state here
};

export const { roomStore, useRoomStore } = createRoomStore<RoomState>(
  persistSliceConfigs(
    {
      name: 'girdwood-str-viewer-state-v2',
      sliceConfigSchemas: {
        room: BaseRoomConfig,
        layout: LayoutConfig,
        sqlEditor: SqlEditorSliceConfig,
      },
    },
    (set, get, store) => ({
      ...createRoomShellSlice({
        config: {
          title: 'Girdwood STR Lake',
        },
        layout: {
          config: {
            id: 'main',
            type: 'tabs',
            children: [
              RoomPanelTypes.enum.overview,
              RoomPanelTypes.enum.listings,
              RoomPanelTypes.enum.sql,
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
            [RoomPanelTypes.enum.sql]: {
              title: 'SQL',
              icon: TerminalIcon,
              component: SqlView,
            },
          },
        },
      })(set, get, store),

      ...createSqlEditorSlice({
        config: {
          ...createDefaultSqlEditorConfig(),
          queries: SEED_QUERIES,
          selectedQueryId: SEED_QUERIES[0]!.id,
          openTabs: [SEED_QUERIES[0]!.id],
        },
      })(set, get, store),

      ...createDataInitSlice()(set, get, store),
    }),
  ),
);
