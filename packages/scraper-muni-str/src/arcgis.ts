/**
 * ArcGIS FeatureServer layer queries.
 *
 * A query returns at most the layer's `maxRecordCount` features (2000 for
 * the registration layers), so `fetchLayer` pages with `resultOffset` in
 * `OBJECTID` order until the server stops reporting `exceededTransferLimit`,
 * then compares the total against the server's own count. ArcGIS reports
 * most failures as HTTP 200 with an `error` body, which `getJson` turns into
 * a thrown error.
 */

import { fetchText } from '@anchorage-str-db/utils/http';
import type { Pacer } from '@anchorage-str-db/utils/pace';
import { withRetries } from '@anchorage-str-db/utils/retry';

export interface ArcgisFeature {
  attributes: Record<string, unknown>;
  /** `{x, y}` in the requested `outSR` for a point layer; absent when not requested. */
  geometry?: { x?: number | null; y?: number | null } | null;
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
