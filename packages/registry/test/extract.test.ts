import { describe, expect, it } from 'vitest';

import type { LayerInfo } from '../src/arcgis/layer.ts';
import { IncompleteResponseError, type Feature } from '../src/arcgis/query.ts';
import { batchSize, extractRegistry } from '../src/extract.ts';

function layer(overrides: Partial<LayerInfo> = {}): LayerInfo {
  return {
    url: 'https://example.test/FeatureServer/0',
    name: 'STR Registrations',
    geometryType: 'esriGeometryPoint',
    objectIdField: 'OBJECTID',
    maxRecordCount: 2,
    lastEditMs: Date.UTC(2026, 8, 1),
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: null, length: null },
      { name: 'STR_Number', type: 'esriFieldTypeString', alias: null, length: null },
      { name: 'Status', type: 'esriFieldTypeString', alias: null, length: null },
      { name: 'Notes', type: 'esriFieldTypeString', alias: null, length: null },
    ],
    ...overrides,
  };
}

function features(objectIds: readonly number[]): Feature[] {
  return objectIds.map((id) => ({
    attributes: { OBJECTID: id, STR_Number: `STR-2026-${id}`, Status: 'Active', Notes: null },
    geometry: { x: -149, y: 61 },
  }));
}

const URL = 'https://example.test/FeatureServer/0';

describe('batchSize', () => {
  it("takes the layer's page size, capped by our own ceiling", () => {
    expect(batchSize(layer({ maxRecordCount: 500 }))).toBe(500);
    expect(batchSize(layer({ maxRecordCount: 100_000 }))).toBe(2000);
    expect(batchSize(layer({ maxRecordCount: null }))).toBe(1000);
    expect(batchSize(layer({ maxRecordCount: 0 }))).toBe(1);
  });
});

describe('extractRegistry', () => {
  it('reads every record, in batches of the page size', async () => {
    const batches: number[][] = [];
    const extract = await extractRegistry(URL, {
      fetchLayer: async () => layer(),
      fetchIds: async () => [1, 2, 3, 4, 5],
      fetchBatch: async (_url, objectIds) => {
        batches.push([...objectIds]);
        return features(objectIds);
      },
    });

    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(extract.records).toHaveLength(5);
    expect(extract.expected).toBe(5);
    expect(extract.records.map((record) => record.registrationId)).toEqual([
      'STR20261',
      'STR20262',
      'STR20263',
      'STR20264',
      'STR20265',
    ]);
  });

  it('reports the layer fields no column claimed', async () => {
    const extract = await extractRegistry(URL, {
      fetchLayer: async () => layer(),
      fetchIds: async () => [],
      fetchBatch: async () => [],
    });
    expect(extract.unmapped).toEqual(['Notes']);
    expect(extract.fieldMap.registrationId).toBe('STR_Number');
  });

  it('halves a truncated batch and keeps the smaller size for the rest', async () => {
    const attempted: number[][] = [];
    const extract = await extractRegistry(URL, {
      fetchLayer: async () => layer({ maxRecordCount: 4 }),
      fetchIds: async () => [1, 2, 3, 4, 5, 6],
      fetchBatch: async (_url, objectIds) => {
        attempted.push([...objectIds]);
        if (objectIds.length > 2) {
          throw new IncompleteResponseError(`truncated a batch of ${objectIds.length}`);
        }
        return features(objectIds);
      },
    });

    expect(attempted).toEqual([
      [1, 2, 3, 4], // truncated, so split
      [1, 2],
      [3, 4],
      [5, 6], // the smaller size carried forward
    ]);
    expect(extract.records.map((record) => record.objectId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('gives up rather than returning a partial extract', async () => {
    // A partial extract is indistinguishable from a registry that lost those
    // records, and the merge would close their intervals as removals.
    await expect(
      extractRegistry(URL, {
        fetchLayer: async () => layer(),
        fetchIds: async () => [1, 2, 3],
        fetchBatch: async (_url, objectIds) => {
          if (objectIds.includes(3)) throw new IncompleteResponseError('still truncated');
          return features(objectIds);
        },
      }),
    ).rejects.toThrow(IncompleteResponseError);
  });

  it('asks for no geometry from a layer that has none', async () => {
    const asked: boolean[] = [];
    await extractRegistry(URL, {
      fetchLayer: async () => layer({ geometryType: null }),
      fetchIds: async () => [1],
      fetchBatch: async (_url, objectIds, withGeometry) => {
        asked.push(withGeometry);
        return features(objectIds).map(({ attributes }) => ({ attributes }));
      },
    });
    expect(asked).toEqual([false]);
  });
});
