import {DeckJsonMap} from '@sqlrooms/deck';
import type {DeckDatasetInput, DeckJsonMapProps} from '@sqlrooms/deck';
import {useMemo, useState, type FC} from 'react';
import {DataStatusGate} from './DataStatusGate';

const LISTINGS_DATASET = 'currentListings';

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

/**
 * One point per current listing, as WKB geometry for `@sqlrooms/deck` (needs
 * the spatial extension loaded in `store.ts`). `location_precision` is text so
 * the legend is readable.
 */
const LISTINGS_QUERY = `
  SELECT
    l.listing_id,
    l.name,
    l.bedrooms,
    o.rating_value,
    o.review_count,
    o.price_hint_per_night,
    CASE
      WHEN l.location_is_exact THEN 'Exact'
      WHEN l.location_is_exact IS NULL THEN 'Unknown'
      ELSE 'Approximate'
    END AS location_precision,
    ST_AsWKB(ST_Point(l.location_lng, l.location_lat)) AS geometry
  FROM listings l
  LEFT JOIN (
    SELECT *
    FROM listing_observations
    QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY scrape_date DESC) = 1
  ) o ON o.listing_id = l.listing_id
  WHERE l.is_current
    AND l.location_lat IS NOT NULL
    AND l.location_lng IS NOT NULL
`;

type ColorMode = 'precision' | 'price';

const PRECISION_COLOR = {
  '@@function': 'colorScale',
  type: 'categorical',
  field: 'location_precision',
  scheme: 'Set1',
  nullColor: [148, 163, 184, 180],
  legend: {title: 'Map pin precision'},
} as const;

// Quantile bins: prices range from ~$60 to over $1,000, so a linear scale
// would put most listings in the lowest color.
const PRICE_COLOR = {
  '@@function': 'colorScale',
  type: 'quantile',
  field: 'price_hint_per_night',
  scheme: 'YlOrRd',
  bins: 5,
  nullColor: [148, 163, 184, 140],
  legend: {title: 'Price hint / night ($)'},
} as const;

const createLayers = (colorMode: ColorMode) => [
  {
    '@@type': 'GeoArrowScatterplotLayer',
    id: 'listings',
    _sqlroomsBinding: {dataset: LISTINGS_DATASET},
    pickable: true,
    filled: true,
    stroked: true,
    opacity: 0.85,
    radiusUnits: 'pixels',
    radiusMinPixels: 4,
    radiusMaxPixels: 10,
    getRadius: 5,
    getFillColor: colorMode === 'price' ? PRICE_COLOR : PRECISION_COLOR,
    getLineColor: [255, 255, 255, 200],
    lineWidthMinPixels: 1,
  },
];

type ListingRow = {
  name: string | null;
  bedrooms: string | null;
  rating_value: number | null;
  review_count: number | null;
  price_hint_per_night: number | null;
  location_precision: string | null;
};

export const MapView: FC = () => {
  const [colorMode, setColorMode] = useState<ColorMode>('precision');

  const datasets = useMemo<Record<string, DeckDatasetInput>>(
    () => ({
      [LISTINGS_DATASET]: {
        sqlQuery: LISTINGS_QUERY,
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
        const row = object as ListingRow;
        const lines: string[] = [];
        if (row.name) lines.push(row.name);
        if (row.bedrooms != null) lines.push(row.bedrooms);
        if (row.price_hint_per_night != null) {
          lines.push(`~$${Math.round(row.price_hint_per_night)}/night`);
        }
        if (row.rating_value != null) {
          lines.push(
            `${row.rating_value.toFixed(2)}★` +
              (row.review_count != null ? ` (${row.review_count} reviews)` : ''),
          );
        }
        if (row.location_precision) {
          lines.push(`${row.location_precision} location`);
        }
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
          // A separate WebGL context: sharing MapLibre's breaks layer drawing
          // after StrictMode's dev remount.
          interleaved={false}
        />

        <div className="pointer-events-none absolute inset-0 z-20">
          <div className="bg-background/90 pointer-events-auto absolute top-3 left-3 w-72 rounded-md border shadow-lg backdrop-blur">
            <div className="border-b px-3 py-2">
              <p className="text-sm font-medium">Currently active listings</p>
              <p className="text-muted-foreground mt-0.5 text-[11px] leading-tight">
                Airbnb only publishes an exact pin for some listings; the rest
                are deliberately shifted by up to a few hundred metres, so read
                an approximate dot as a neighbourhood, not an address.
              </p>
            </div>
            <div className="space-y-1.5 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
                <input
                  type="radio"
                  name="map-color-mode"
                  checked={colorMode === 'precision'}
                  onChange={() => setColorMode('precision')}
                />
                Colour by pin precision
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
                <input
                  type="radio"
                  name="map-color-mode"
                  checked={colorMode === 'price'}
                  onChange={() => setColorMode('price')}
                />
                Colour by price hint
              </label>
            </div>
          </div>
        </div>
      </div>
    </DataStatusGate>
  );
};
