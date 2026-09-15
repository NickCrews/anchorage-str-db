import type {WasmRow} from '@anchorage-str-db/db/rows';
import {airbnbListingObservations} from '@anchorage-str-db/db/schema';
import {from, toSql} from '@anchorage-str-db/db/sql';
import {
  listingsCurrentWithRegistration,
  registrations,
  registrationsCurrent,
} from '@anchorage-str-db/db/viewSchema';
import {
  buildColorScaleLegend,
  type ResolvedColorLegend,
} from '@sqlrooms/color-scales';
import {DeckJsonMap} from '@sqlrooms/deck';
import type {DeckDatasetInput, DeckJsonMapProps} from '@sqlrooms/deck';
import {sql} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import {useCallback, useMemo, useState, type FC} from 'react';
import {registrationStatusSql} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

const RENTALS_DATASET = 'currentRentals';

const NOT_ON_AIRBNB = 'Registered, not on Airbnb';

// Anchorage bowl plus Girdwood/Eagle River, which the scrape bbox covers.
const ANCHORAGE_VIEW_STATE = {
  latitude: 61.16,
  longitude: -149.75,
  zoom: 9.2,
  bearing: 0,
  pitch: 0,
};

// Light basemap to match the app's light default theme.
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

const l = alias(listingsCurrentWithRegistration, 'l');
const r = alias(registrations, 'r');
/** Each listing's latest observation: one row of the table it comes from. */
const o = alias(airbnbListingObservations, 'o');

/**
 * One point per short-term rental we know of, as WKB geometry for
 * `@sqlrooms/deck` (needs the spatial extension loaded in `store.ts`): every
 * current Airbnb listing, plus every current Muni registration that no current
 * Airbnb listing cites (rentals listed elsewhere, such as VRBO, or not listed).
 * Registrations the Muni's geocoder could not place are left out.
 *
 * A listing's point is the Muni's geocoding of the registration it cites when
 * there is one, otherwise Airbnb's pin. `is_precise` is true for a geocoded
 * license address or an exact Airbnb pin, and false for an Airbnb pin shifted
 * by up to a few hundred meters.
 */
const RENTALS_QUERY = sql`
  SELECT
    ${l.name},
    ${l.bedrooms},
    ${l.roomType},
    ${o.ratingValue},
    ${o.reviewCount},
    ${o.priceHintPerNight},
    ${registrationStatusSql(l)} AS registration_status,
    ${l.strRegistrationId},
    ${l.registrationLocation},
    CASE
      WHEN ${r.geocodedLat} IS NOT NULL THEN 'License address'
      WHEN ${l.locationIsExact} THEN 'Exact Airbnb pin'
      ELSE 'Approximate Airbnb pin'
    END AS location_source,
    ${r.geocodedLat} IS NOT NULL OR coalesce(${l.locationIsExact}, false) AS is_precise,
    ST_AsWKB(ST_Point(
      coalesce(${r.geocodedLng}, ${l.locationLng}),
      coalesce(${r.geocodedLat}, ${l.locationLat})
    )) AS geometry
  FROM ${from(listingsCurrentWithRegistration, l)}
  LEFT JOIN ${from(registrations, r)}
    ON ${r.registrationNumber} = ${l.strRegistrationId}
    AND ${r.geocodedLat} IS NOT NULL
    AND ${r.geocodedLng} IS NOT NULL
  LEFT JOIN (
    SELECT *
    FROM ${from(airbnbListingObservations)}
    QUALIFY row_number() OVER (
      PARTITION BY ${airbnbListingObservations.listingId}
      ORDER BY ${airbnbListingObservations.scrapeDate} DESC
    ) = 1
  ) ${o} ON ${o.listingId} = ${l.listingId}
  WHERE coalesce(${r.geocodedLat}, ${l.locationLat}) IS NOT NULL
    AND coalesce(${r.geocodedLng}, ${l.locationLng}) IS NOT NULL

  UNION ALL BY NAME

  SELECT
    ${registrationsCurrent.businessName} AS name,
    ${NOT_ON_AIRBNB} AS registration_status,
    ${registrationsCurrent.registrationNumber} AS str_registration_id,
    ${registrationsCurrent.location} AS registration_location,
    'License address' AS location_source,
    true AS is_precise,
    ST_AsWKB(ST_Point(
      ${registrationsCurrent.geocodedLng},
      ${registrationsCurrent.geocodedLat}
    )) AS geometry
  FROM ${from(registrationsCurrent)}
  WHERE ${registrationsCurrent.airbnbListingsCurrent} = 0
    AND ${registrationsCurrent.geocodedLat} IS NOT NULL
    AND ${registrationsCurrent.geocodedLng} IS NOT NULL
`;

type ColorMode = 'registration' | 'price';

type RgbaColor = [number, number, number, number];

type RentalsTable = Extract<
  Parameters<NonNullable<DeckJsonMapProps['onDatasetStatesChange']>>[0][string],
  {status: 'ready'}
>['prepared']['table'];

// Quantile bins: prices range from ~$60 to over $1,000, so a linear scale
// would put most listings in the lowest color.
const PRICE_COLOR = {
  '@@function': 'colorScale',
  type: 'quantile',
  field: 'price_hint_per_night',
  scheme: 'YlOrRd',
  bins: 5,
  nullColor: [148, 163, 184, 140] as RgbaColor,
  legend: {title: 'Price hint / night ($)'},
} as const;

const REGISTRATION_COLOR = {
  '@@function': 'colorScale',
  type: 'categorical',
  field: 'registration_status',
  scheme: 'Set1',
  nullColor: [148, 163, 184, 180] as RgbaColor,
  legend: {title: 'Registration status'},
} as const;

const FILL_COLOR = {
  registration: REGISTRATION_COLOR,
  price: PRICE_COLOR,
} as const;

// Every color-scale accessor gets its own legend, so the rings are not a
// second colored layer: approximate points are drawn as full dots and a
// basemap-colored disc is drawn over their centers.
const createLayers = (colorMode: ColorMode) => [
  {
    '@@type': 'GeoArrowScatterplotLayer',
    id: 'rentals',
    _sqlroomsBinding: {dataset: RENTALS_DATASET},
    pickable: true,
    filled: true,
    stroked: false,
    radiusUnits: 'pixels',
    getRadius: '@@=is_precise ? 5 : 6',
    getFillColor: FILL_COLOR[colorMode],
  },
  {
    '@@type': 'GeoArrowScatterplotLayer',
    id: 'approximate-centers',
    _sqlroomsBinding: {dataset: RENTALS_DATASET},
    pickable: false,
    filled: true,
    stroked: false,
    radiusUnits: 'pixels',
    getRadius: '@@=is_precise ? 0 : 3.5',
    getFillColor: [250, 250, 248, 255],
  },
];

/** A row of `RENTALS_QUERY`, as DuckDB-WASM hands it to the tooltip. */
type RentalRow = Pick<
  WasmRow<typeof listingsCurrentWithRegistration>,
  'name' | 'bedrooms' | 'room_type' | 'str_registration_id' | 'registration_location'
> &
  Pick<
    WasmRow<typeof airbnbListingObservations>,
    'rating_value' | 'review_count' | 'price_hint_per_night'
  > & {
    // Columns the query itself derives.
    registration_status: string | null;
    location_source: string;
  };

const rentalTooltip = (row: RentalRow): string[] => {
  const lines: string[] = [];
  if (row.name) lines.push(row.name);
  const size = [row.room_type, row.bedrooms].filter(Boolean).join(', ');
  if (size) lines.push(size);
  if (row.price_hint_per_night != null) {
    lines.push(`~$${Math.round(row.price_hint_per_night)}/night`);
  }
  if (row.rating_value != null) {
    lines.push(
      `${row.rating_value.toFixed(2)}★` +
        (row.review_count != null ? ` (${row.review_count} reviews)` : ''),
    );
  }
  if (row.registration_status) {
    lines.push(
      row.str_registration_id
        ? `${row.registration_status}: ${row.str_registration_id}`
        : row.registration_status,
    );
  }
  if (row.registration_location) {
    lines.push(`Registered at ${row.registration_location}`);
  }
  lines.push(`Location: ${row.location_source}`);
  return lines;
};

/**
 * The legend for the active color scale, built from the loaded rows the same
 * way `DeckJsonMap` builds its own, so it can be drawn inside the controls card.
 */
const buildLegend = (
  table: RentalsTable | null,
  colorMode: ColorMode,
): ResolvedColorLegend | null => {
  const colorScale = FILL_COLOR[colorMode];
  const column = table?.getChild(colorScale.field);
  if (!column) return null;
  return buildColorScaleLegend({
    colorScale,
    values: Array.from({length: column.length}, (_, i) => column.get(i)),
    title: colorScale.legend.title,
  });
};

const rgba = ([r, g, b, a]: readonly number[]) =>
  `rgba(${r}, ${g}, ${b}, ${(a ?? 255) / 255})`;

const LegendSwatches: FC<{legend: ResolvedColorLegend}> = ({legend}) => {
  if (legend.type === 'continuous') {
    return (
      <div
        className="h-3 rounded-[2px] border"
        style={{background: legend.gradient}}
      />
    );
  }
  return (
    <ul className="space-y-1">
      {legend.items.map((item) => (
        <li
          key={item.label}
          className="flex items-center gap-2 text-xs leading-tight"
        >
          <span
            aria-hidden
            className="h-3 w-3 shrink-0 rounded-[2px] border"
            style={{backgroundColor: rgba(item.color)}}
          />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
};

export const MapView: FC = () => {
  const [colorMode, setColorMode] = useState<ColorMode>('registration');
  const [rentalsTable, setRentalsTable] = useState<RentalsTable | null>(null);

  const handleDatasetStatesChange = useCallback<
    NonNullable<DeckJsonMapProps['onDatasetStatesChange']>
  >((states) => {
    const state = states[RENTALS_DATASET];
    setRentalsTable(state?.status === 'ready' ? state.prepared.table : null);
  }, []);

  const legend = useMemo(
    () => buildLegend(rentalsTable, colorMode),
    [rentalsTable, colorMode],
  );

  const datasets = useMemo<Record<string, DeckDatasetInput>>(
    () => ({
      [RENTALS_DATASET]: {
        sqlQuery: toSql(RENTALS_QUERY),
        geometryColumn: 'geometry',
        geometryEncodingHint: 'wkb',
      },
    }),
    [],
  );

  const spec = useMemo(
    () => ({
      initialViewState: ANCHORAGE_VIEW_STATE,
      controller: true,
      layers: createLayers(colorMode),
    }),
    [colorMode],
  );

  const deckProps = useMemo<DeckJsonMapProps['deckProps']>(
    () => ({
      getTooltip: ({object}: {object?: unknown}) => {
        if (!object) return null;
        const lines = rentalTooltip(object as RentalRow);
        return lines.length ? {text: lines.join('\n')} : null;
      },
    }),
    [],
  );

  return (
    <DataStatusGate>
      <div className="relative h-full w-full">
        <DeckJsonMap
          className="absolute inset-0"
          spec={spec}
          datasets={datasets}
          mapStyle={MAP_STYLE}
          deckProps={deckProps}
          // The legend is drawn in the controls card below.
          showLegends={false}
          onDatasetStatesChange={handleDatasetStatesChange}
          // A separate WebGL context: sharing MapLibre's breaks layer drawing
          // after StrictMode's dev remount.
          interleaved={false}
        />

        <div className="pointer-events-none absolute inset-0 z-20">
          <div className="bg-background/90 pointer-events-auto absolute top-3 left-3 w-72 rounded-md border shadow-lg backdrop-blur">
            <div className="border-b px-3 py-2">
              <p className="text-sm font-medium">Current short-term rentals</p>
              <p className="text-muted-foreground mt-0.5 text-[11px] leading-tight">
                Every current Airbnb listing, plus every current Muni
                registration no Airbnb listing cites. Filled dots are at a
                known location: the registered license address, or an exact
                Airbnb pin. Rings are Airbnb pins shifted by up to a few
                hundred meters, so read them as a neighborhood, not an address.
              </p>
            </div>
            <div className="space-y-1.5 px-3 py-2">
              {(
                [
                  ['registration', 'Color by registration status'],
                  ['price', 'Color by price hint'],
                ] as const
              ).map(([mode, label]) => (
                <label
                  key={mode}
                  className="flex cursor-pointer items-center gap-2 text-sm select-none"
                >
                  <input
                    type="radio"
                    name="map-color-mode"
                    checked={colorMode === mode}
                    onChange={() => setColorMode(mode)}
                  />
                  {label}
                </label>
              ))}
            </div>
            {legend && (
              <div className="border-t px-3 py-2">
                <p className="mb-1.5 text-xs font-semibold">{legend.title}</p>
                <LegendSwatches legend={legend} />
              </div>
            )}
          </div>
        </div>
      </div>
    </DataStatusGate>
  );
};
