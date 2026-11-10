import { describe, expect, it } from 'vitest';

import { epochMsToTimestamp, fetchLayer, type FetchJson } from '../src/arcgis.ts';

const LAYER = 'https://example.test/FeatureServer/0';

/** A layer of `total` features served `maxRecordCount` at a time, as ArcGIS does. */
function fakeLayer(total: number, maxRecordCount: number, reportedCount = total): { fetchJson: FetchJson; urls: string[] } {
  const urls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    urls.push(url);
    const params = new URL(url).searchParams;
    if (params.get('returnCountOnly') === 'true') return { count: reportedCount };
    const offset = Number(params.get('resultOffset'));
    const size = Math.min(Number(params.get('resultRecordCount')), maxRecordCount);
    const ids = Array.from({ length: Math.max(0, Math.min(size, total - offset)) }, (_, i) => offset + i + 1);
    return {
      features: ids.map((id) => ({ attributes: { OBJECTID: id } })),
      exceededTransferLimit: offset + ids.length < total,
    };
  };
  return { fetchJson, urls };
}

describe('fetchLayer', () => {
  it('pages in OBJECTID order until the server stops reporting more', async () => {
    const { fetchJson, urls } = fakeLayer(5, 2);
    const { features, serverCount } = await fetchLayer(LAYER, { fetchJson, pageSize: 2, returnGeometry: false });

    expect(serverCount).toBe(5);
    expect(features.map((f) => f.attributes.OBJECTID)).toEqual([1, 2, 3, 4, 5]);
    // The count, then three pages.
    expect(urls).toHaveLength(4);
    expect(new URL(urls[1]!).searchParams.get('orderByFields')).toBe('OBJECTID ASC');
  });

  it("throws when the pages don't add up to the server's count", async () => {
    const { fetchJson } = fakeLayer(3, 2, 4);

    await expect(fetchLayer(LAYER, { fetchJson, pageSize: 2, returnGeometry: false })).rejects.toThrow(
      /fetched 3 features but the server counts 4/,
    );
  });
});

describe('epochMsToTimestamp', () => {
  it('reads epoch milliseconds as naive UTC', () => {
    expect(epochMsToTimestamp(Date.UTC(2026, 8, 7, 0, 15, 52))).toBe('2026-09-07 00:15:52');
    expect(epochMsToTimestamp(null)).toBeNull();
  });
});
