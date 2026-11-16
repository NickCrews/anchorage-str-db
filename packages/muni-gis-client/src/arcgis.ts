/**
 * ArcGIS REST queries: FeatureServer layers, and the JSON fetcher every
 * client in this package uses.
 *
 * A query returns at most the layer's `maxRecordCount` features, so `fetchLayer` pages with `resultOffset` in
 * `OBJECTID` order until the server stops reporting `exceededTransferLimit`,
 * then compares the total against the server's own count. ArcGIS reports
 * most failures as HTTP 200 with an `error` body, which `getJson` turns into
 * a thrown error.
 */

import { fetchText } from '@anchorage-str-db/utils/http';
import { Pacer } from '@anchorage-str-db/utils/pace';
import { withRetries } from '@anchorage-str-db/utils/retry';

export interface ArcgisFeature {
  attributes: Record<string, unknown>;
  /**
   * In the requested `outSR`: `{x, y}` for a point layer, `{rings}` for a
   * polygon layer (each ring `[x, y]` pairs). Absent when not requested.
   */
  geometry?: { x?: number | null; y?: number | null; rings?: [number, number][][] } | null;
}

export interface LayerQueryResult {
  features: ArcgisFeature[];
  /** The server's `returnCountOnly` count, taken before the pages. */
  serverCount: number;
}

/** One GET of an ArcGIS REST URL, parsed. */
export type FetchJson = (url: string) => Promise<unknown>;

export class ArcgisError extends Error {
  constructor(url: string, body: unknown) {
    super(`ArcGIS error for ${url}: ${JSON.stringify(body).slice(0, 300)}`);
    this.name = 'ArcgisError';
  }
}

export interface LiveJsonFetcherOptions {
  pacer: Pacer;
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
}

/** Real requests, paced and retried; an `error` body is retried like an HTTP error. */
export function liveJsonFetcher(options: LiveJsonFetcherOptions): FetchJson {
  return (url) =>
    withRetries(
      async () => {
        const body: unknown = JSON.parse(await fetchText(url, options.timeoutMs));
        if (body !== null && typeof body === 'object' && 'error' in body) {
          throw new ArcgisError(url, (body as { error: unknown }).error);
        }
        return body;
      },
      {
        label: `ArcGIS request ${url}`,
        attempts: options.attempts,
        backoffMs: options.backoffMs,
        pacer: options.pacer,
      },
    );
}

/** The Muni's ArcGIS Online services: community councils, property information. */
export const MUNI_ARCGIS_SERVICES = 'https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services';

/**
 * Real requests to `MUNI_ARCGIS_SERVICES`, at 2 a second with one `Pacer`
 * per fetcher. ArcGIS Online answers a layer query in well under a second.
 */
export function liveMuniArcgisFetcher(
  pacer = new Pacer({ rate: 2, service: "the Muni's ArcGIS Online services" }),
): FetchJson {
  return liveJsonFetcher({ pacer, timeoutMs: 60_000, attempts: 3, backoffMs: 1000 });
}

export interface FetchLayerOptions {
  fetchJson: FetchJson;
  /** Features per request; at most the layer's `maxRecordCount`. */
  pageSize: number;
  /** Whether to request geometry, in WGS84 (`outSR=4326`). */
  returnGeometry: boolean;
}

/** Every feature in the layer, all fields. Throws if the pages don't add up to the server's count. */
export async function fetchLayer(
  layerUrl: string,
  options: FetchLayerOptions,
): Promise<LayerQueryResult> {
  const countBody = (await options.fetchJson(
    `${layerUrl}/query?${new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' })}`,
  )) as { count?: unknown };
  if (typeof countBody.count !== 'number') {
    throw new Error(`${layerUrl}: count query returned no count`);
  }
  const serverCount = countBody.count;

  const features: ArcgisFeature[] = [];
  for (let offset = 0; ; offset += options.pageSize) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      orderByFields: 'OBJECTID ASC',
      resultOffset: String(offset),
      resultRecordCount: String(options.pageSize),
      returnGeometry: String(options.returnGeometry),
      outSR: '4326',
      f: 'json',
    });
    const body = (await options.fetchJson(`${layerUrl}/query?${params}`)) as {
      features?: ArcgisFeature[];
      exceededTransferLimit?: boolean;
    };
    if (!Array.isArray(body.features)) {
      throw new Error(`${layerUrl}: page at offset ${offset} has no features array`);
    }
    features.push(...body.features);
    if (!body.exceededTransferLimit || body.features.length === 0) break;
  }

  if (features.length !== serverCount) {
    throw new Error(
      `${layerUrl}: fetched ${features.length} features but the server counts ${serverCount}; ` +
        'the layer probably changed mid-fetch',
    );
  }
  return { features, serverCount };
}

/**
 * When the layer's data was last edited, as a naive UTC timestamp, from the
 * layer's `editingInfo.dataLastEditDate`. Null if the layer doesn't report it.
 */
export async function fetchLayerDataEditedAt(
  layerUrl: string,
  fetchJson: FetchJson,
): Promise<string | null> {
  const body = (await fetchJson(`${layerUrl}?f=json`)) as {
    editingInfo?: { dataLastEditDate?: unknown };
  };
  return epochMsToTimestamp(body.editingInfo?.dataLastEditDate);
}

/** An ArcGIS `esriFieldTypeDate` (epoch milliseconds) as `YYYY-MM-DD HH:MM:SS` UTC. */
export function epochMsToTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}
