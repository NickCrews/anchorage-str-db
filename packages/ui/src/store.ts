import {
  BaseRoomConfig,
  createRoomShellSlice,
  createRoomStore,
  LayoutConfig,
  persistSliceConfigs,
  type RoomShellSliceState,
} from '@sqlrooms/room-shell';
import { createWasmDuckDbConnector } from '@sqlrooms/duckdb';
import { FileBadgeIcon, LayoutDashboardIcon, ListIcon, MapIcon, UsersIcon } from 'lucide-react';
import { z } from 'zod';
import { HostsView } from './components/HostsView';
import { ListingsView } from './components/ListingsView';
import { MapView } from './components/MapView';
import { OverviewView } from './components/OverviewView';
import { RegistrationsView } from './components/RegistrationsView';
import { createDataInitSlice, type DataInitSliceState } from './dataInitSlice';

export const RoomPanelTypes = z.enum([
  'overview',
  'listings',
  'map',
  'hosts',
  'registrations',
] as const);
export type RoomPanelTypes = z.infer<typeof RoomPanelTypes>;

/** App state: SQLRooms' room shell plus the data-attach slice. */
export type RoomState = RoomShellSliceState & DataInitSliceState;

export const { roomStore, useRoomStore } = createRoomStore<RoomState>(
  persistSliceConfigs(
    {
      name: 'anchorage-str-db-viewer-state-v5',
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
              RoomPanelTypes.enum.hosts,
              RoomPanelTypes.enum.registrations,
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
            [RoomPanelTypes.enum.hosts]: {
              title: 'Hosts',
              icon: UsersIcon,
              component: HostsView,
            },
            [RoomPanelTypes.enum.registrations]: {
              title: 'Registrations',
              icon: FileBadgeIcon,
              component: RegistrationsView,
            },
          },
        },
      })(set, get, store),

      ...createDataInitSlice()(set, get, store),
    }),
  ),
);
