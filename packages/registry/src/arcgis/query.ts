/**
 * Feature queries: `POST <layer>/query`.
 *
 * The extract runs in two steps rather than paging with `resultOffset`:
 *
 * 1. `queryObjectIds` asks for every object id (`returnIdsOnly=true`), which
 *    the server answers in one response regardless of `maxRecordCount`.
 * 2. `queryByObjectIds` fetches the rows in batches of those ids.
 *
 * Offset paging would be shorter, but it re-runs the query for every page.
 * A registration edited between two pages shifts the rows after it, so a row
 * is silently skipped or returned twice — the same hazard that made the
 * Airbnb search stop paginating (see
 * `docs/research/airbnb-search-pagination.md`). Fetching an id list first
 * pins the extract to one set of records: a row edited mid-extract is read
 * once, at whichever value it then has, and a row inserted mid-extract is
 * missed by this run and picked up by the next. Not every layer supports
 * `supportsPagination` either, while `returnIdsOnly` is universal.
 *
 * Both functions verify what came back rather than trusting it: ArcGIS
 * truncates an oversized response and reports it in a flag that is easy to
 * ignore.
 */

import { OUT_SPATIAL_REFERENCE } from '../config.ts';
import { requestJson } from './http.ts';

/** A feature's attributes, as the layer returns them. */
export type Attributes = Record<string, string | number | boolean | null>;

export interface Feature {
  attributes: Attributes;
  /** Present when the layer has geometry and it was requested. */
  geometry?: { x?: number; y?: number } | Record<string, unknown>;
}

interface IdsResponse {
  objectIdFieldName?: string;
  objectIds?: number[] | null;
}

interface FeaturesResponse {
  features?: Feature[];
  exceededTransferLimit?: boolean;
}

/** Raised when a response is missing records the request asked for. */
export class IncompleteResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteResponseError';
  }
}

/**
 * Every object id in the layer, ascending.
 *
 * Sorted so that batches are contiguous ranges, which servers answer from an
 * index, and so a run's batching is reproducible.
 */
export async function queryObjectIds(url: string, where = '1=1'): Promise<number[]> {
  const response = await requestJson<IdsResponse>(`${url}/query`, {
    where,
    returnIdsOnly: 'true',
  });
  // `null` (rather than `[]`) is how some servers answer a query matching
  // nothing; an absent key means the response was not an id response at all.
  if (response.objectIds === undefined) {
    throw new IncompleteResponseError(`${url}/query returned no objectIds field`);
  }
  return [...(response.objectIds ?? [])].sort((a, b) => a - b);
}

/**
 * The features for `objectIds`, in one request.
 *
 * Throws `IncompleteResponseError` if the server truncated the response or
 * returned a different number of rows than were asked for, so a caller never
 * mistakes a truncated batch for a complete one. `fetchAll` shrinks the batch
 * and retries.
 */
export async function queryByObjectIds(
  url: string,
  objectIds: readonly number[],
  withGeometry: boolean,
): Promise<Feature[]> {
  if (objectIds.length === 0) return [];

  const response = await requestJson<FeaturesResponse>(`${url}/query`, {
    // `objectIds` rather than a `where ... IN (...)`: the server parses it as
    // a list instead of a SQL expression, so there is no quoting to get
    // wrong and no expression-length limit to hit.
    objectIds: objectIds.join(','),
    where: '1=1',
    outFields: '*',
    returnGeometry: String(withGeometry),
    ...(withGeometry ? { outSR: String(OUT_SPATIAL_REFERENCE) } : {}),
  });

  const features = response.features ?? [];
  if (response.exceededTransferLimit) {
    throw new IncompleteResponseError(
      `${url}/query truncated a batch of ${objectIds.length} (exceededTransferLimit)`,
    );
  }
  // A batch names its rows explicitly, so anything short of the full count is
  // a truncation the flag did not report. More rows than asked for means the
  // `objectIds` filter was ignored, which would make the extract meaningless.
  if (features.length !== objectIds.length) {
    throw new IncompleteResponseError(
      `${url}/query returned ${features.length} features for ${objectIds.length} object ids`,
    );
  }
  return features;
}
