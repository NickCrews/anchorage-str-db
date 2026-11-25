import { buildColorScaleLegend, type ResolvedColorLegend } from '@sqlrooms/color-scales';
import { DeckJsonMap, type DeckDatasetInput, type DeckJsonMapProps } from '@sqlrooms/deck';
import { Query, sql, useMosaicClient } from '@sqlrooms/mosaic';
import { Table as ArrowTable, vectorFromArray } from 'apache-arrow';
import { useMemo, type FC } from 'react';
import { money } from '../../format';
import { useXf } from './context';

const VIEW_STATE = { latitude: 61.1, longitude: -149.6, zoom: 8.6, bearing: 0, pitch: 0 };
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

type RgbaColor = [number, number, number, number];

export interface XfMapColor {
  field: string;
  type: 'categorical' | 'quantile';
  scheme: string;
  title: string;
}

/** A ring around the picked listing. */
const PICKED_LAYER = {
  '@@type': 'GeoArrowScatterplotLayer',
  id: 'picked',
  _sqlroomsBinding: { dataset: 'picked' },
  pickable: false,
  filled: false,
  stroked: true,
  getLineColor: [20, 20, 20, 255],
  lineWidthMinPixels: 2.5,
  radiusUnits: 'pixels',
  getRadius: 9,
};

const TOOLTIP_COLUMNS = ['listing_id', 'listing', 'type', 'bedrooms', 'revenue', 'nights booked', 'registration', 'FREHM reason'];

/**
 * One record batch: DuckDB-WASM streams results in ~2k-row batches and the
 * GeoArrow layers draw one sublayer per batch.
 */
function singleBatch(table: ArrowTable): ArrowTable {
  if (table.batches.length <= 1) return table;
  return new ArrowTable(
    Object.fromEntries(table.schema.fields.map((f) => [f.name, vectorFromArray([...table.getChild(f.name)!], f.type)])),
  );
}

/**
 * The chapter's listings on a map. Every listing is drawn in grey; the ones
 * the selection keeps are drawn over them in color, and the picked one is
 * ringed. Clicking a listing picks it.
 */
export const XfMap: FC<{ color: XfMapColor }> = ({ color }) => {
  const { table, selection, version, picked, setPicked } = useXf();
  const columns = useMemo(() => [...new Set([...TOOLTIP_COLUMNS, color.field])], [color.field]);

  const { data } = useMosaicClient({
    // The client keeps its query in a ref, so a new field or month needs a new id.
    id: `xf-map-${table}-${version}-${color.field}`,
    selection,
    query: (filter: unknown) =>
      Query.from(table)
        .select(...columns, { geom: sql`geom` })
        .where(filter as never, sql`geom IS NOT NULL`)
        .orderby(color.field),
  });

  const datasets = useMemo<Record<string, DeckDatasetInput>>(
    () => ({
      all: { sqlQuery: `SELECT geom FROM ${table} WHERE geom IS NOT NULL`, geometryColumn: 'geom', geometryEncodingHint: 'wkb' },
      // Zero rows must not reach deck: GeoArrow fails on an empty table and keeps the old points.
      kept: {
        arrowTable: data && data.numRows > 0 ? singleBatch(data) : undefined,
        geometryColumn: 'geom',
        geometryEncodingHint: 'wkb',
      },
      // Only while a listing is picked: an empty query leaves the layer no geometry column to bind.
      ...(picked != null
        ? {
            picked: {
              sqlQuery: `SELECT geom FROM ${table} WHERE geom IS NOT NULL AND listing_id = '${picked.replaceAll("'", "''")}'`,
              geometryColumn: 'geom',
              geometryEncodingHint: 'wkb' as const,
            },
          }
        : {}),
    }),
    // `version` rebuilds the grey layer for the new table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, data, version, picked],
  );

  const colorScale = useMemo(
    () => ({
      '@@function': 'colorScale',
      type: color.type,
      field: color.field,
      scheme: color.scheme,
      ...(color.type === 'quantile' ? { bins: 5 } : {}),
      nullColor: [148, 163, 184, 160] as RgbaColor,
      legend: { title: color.title },
    }),
    [color],
  );

  const spec = useMemo(
    () => ({
      initialViewState: VIEW_STATE,
      controller: true,
      layers: [
        {
          '@@type': 'GeoArrowScatterplotLayer',
          id: 'all',
          _sqlroomsBinding: { dataset: 'all' },
          pickable: false,
          radiusUnits: 'pixels',
          getRadius: 2,
          getFillColor: [160, 160, 160, 90],
        },
        {
          '@@type': 'GeoArrowScatterplotLayer',
          id: 'kept',
          _sqlroomsBinding: { dataset: 'kept' },
          pickable: true,
          stroked: true,
          getLineColor: [255, 255, 255, 200],
          lineWidthMinPixels: 0.5,
          radiusUnits: 'pixels',
          getRadius: 3.5,
          getFillColor: colorScale,
        },
        ...(picked != null ? [PICKED_LAYER] : []),
      ],
    }),
    [colorScale, picked],
  );

  const deckProps = useMemo<DeckJsonMapProps['deckProps']>(
    () => ({
      getTooltip: ({ object }: { object?: Record<string, unknown> }) => {
        if (!object) return null;
        const lines = [
          String(object.listing ?? ''),
          String(object.type ?? ''),
          object.revenue != null ? `About ${money(Number(object.revenue))} from ${object['nights booked']} booked nights` : '',
          object.registration ? `Muni registration: ${String(object.registration).toLowerCase()}` : '',
          object['FREHM reason'] ? String(object['FREHM reason']) : '',
          'Click for details',
        ].filter(Boolean);
        return { text: lines.join('\n') };
      },
      onClick: ({ object }: { object?: Record<string, unknown> }) => {
        if (object) setPicked(String(object.listing_id));
      },
    }),
    [setPicked],
  );

  const legend = useMemo<ResolvedColorLegend | null>(() => {
    const column = data?.getChild(color.field);
    if (!column) return null;
    return buildColorScaleLegend({
      colorScale: colorScale as Parameters<typeof buildColorScaleLegend>[0]['colorScale'],
      values: Array.from({ length: column.length }, (_, i) => column.get(i)),
      title: color.title,
    });
  }, [data, color, colorScale]);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <DeckJsonMap
        className="absolute inset-0"
        spec={spec}
        datasets={datasets}
        mapStyle={MAP_STYLE}
        deckProps={deckProps}
        showLegends={false}
        // A separate WebGL context: sharing MapLibre's breaks layer drawing
        // after StrictMode's dev remount.
        interleaved={false}
      />
      {legend && (
        <div className="bg-background/90 pointer-events-none absolute right-2 bottom-2 z-20 max-w-52 rounded-md border px-2 py-1.5 text-[11px] shadow backdrop-blur">
          <p className="mb-1 font-semibold">{legend.title}</p>
          {legend.type === 'continuous' ? (
            <div className="h-2.5 rounded-sm" style={{ background: legend.gradient }} />
          ) : (
            <ul className="space-y-0.5">
              {legend.items.map((item) => (
                <li key={item.label} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: `rgba(${item.color[0]}, ${item.color[1]}, ${item.color[2]}, ${(item.color[3] ?? 255) / 255})` }}
                  />
                  <span className="truncate">{item.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
