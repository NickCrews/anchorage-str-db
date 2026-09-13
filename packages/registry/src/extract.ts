/**
 * One full extract of the registry layer.
 *
 * All of it, every run: the layer holds current state only, a few thousand
 * rows, and reads in one figure of requests, so there is nothing to gain from
 * an incremental fetch and a whole class of "which rows changed?" bugs to
 * avoid. What makes the day small is the *storage*, which is change-only
 * (see `store.ts`), not the fetch.
 *
 * An extract is all-or-nothing. A batch that cannot be read after its
 * retries throws, and `pipeline.ts` writes nothing: a partial extract looks
 * exactly like a registry that lost those records, and the merge would close
 * their version intervals.
 */

import { fetchLayerInfo, type LayerInfo } from './arcgis/layer.ts';
import {
  queryByObjectIds,
  queryObjectIds,
  IncompleteResponseError,
  type Feature,
} from './arcgis/query.ts';
import { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from './config.ts';
import { mapFields, unmappedFields, type FieldMap } from './fields.ts';
import { log } from './log.ts';
import { toRecords, type RegistrationRecord } from './records.ts';
import { withRetries } from './retry.ts';

export interface Extract {
  layer: LayerInfo;
  fieldMap: FieldMap;
  /** Layer fields no column claimed; stored in `attributes` regardless. */
  unmapped: string[];
  records: RegistrationRecord[];
  /** Object ids the layer listed, which is what a complete extract must return. */
  expected: number;
}

/** The batch size to start at: the server's page size, within our own ceiling. */
export function batchSize(layer: LayerInfo): number {
  const declared = layer.maxRecordCount ?? DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(declared, MAX_BATCH_SIZE));
}

export interface ExtractOptions {
  /** Injected so tests never touch the network. */
  fetchLayer?: (url: string) => Promise<LayerInfo>;
  fetchBatch?: (
    url: string,
    objectIds: readonly number[],
    withGeometry: boolean,
  ) => Promise<Feature[]>;
  fetchIds?: (url: string) => Promise<number[]>;
}

/** Read the layer and every record in it. */
export async function extractRegistry(url: string, options: ExtractOptions = {}): Promise<Extract> {
  const fetchLayer = options.fetchLayer ?? fetchLayerInfo;
  const fetchIds = options.fetchIds ?? ((target: string) => queryObjectIds(target));
  const fetchBatch = options.fetchBatch ?? queryByObjectIds;

  const layer = await withRetries(() => fetchLayer(url), 'layer metadata');
  const fieldMap = mapFields(layer.fields);
  const unmapped = unmappedFields(layer.fields, fieldMap, layer.objectIdField);
  log.info(
    `layer "${layer.name}": ${layer.fields.length} fields, object id ${layer.objectIdField}, ` +
      `geometry ${layer.geometryType ?? 'none'}, max ${layer.maxRecordCount ?? 'unstated'} per page`,
  );

  const objectIds = await withRetries(() => fetchIds(url), 'object ids');
  log.info(`layer lists ${objectIds.length} records`);

  const withGeometry = layer.geometryType !== null;
  let size = batchSize(layer);

  /**
   * Read one batch, halving it on a truncated response and remembering the
   * smaller size for the batches after it. `maxRecordCount` is what the
   * server advertises, but the real limit is a response-size budget, so a
   * layer with long address strings truncates below its own declared page
   * size.
   */
  const readBatch = async (batch: readonly number[]): Promise<Feature[]> => {
    try {
      return await withRetries(
        () => fetchBatch(url, batch, withGeometry),
        `records ${batch[0]}..${batch[batch.length - 1]}`,
      );
    } catch (err) {
      if (!(err instanceof IncompleteResponseError) || batch.length === 1) throw err;
      const half = Math.ceil(batch.length / 2);
      size = Math.min(size, half);
      log.warn(`a batch of ${batch.length} was truncated; reading ${half} at a time`);
      return [...(await readBatch(batch.slice(0, half))), ...(await readBatch(batch.slice(half)))];
    }
  };

  const features: Feature[] = [];
  for (let index = 0; index < objectIds.length; ) {
    const batch = objectIds.slice(index, index + size);
    features.push(...(await readBatch(batch)));
    index += batch.length;
  }

  const records = toRecords(features, fieldMap, layer.objectIdField);
  return { layer, fieldMap, unmapped, records, expected: objectIds.length };
}
