/**
 * The wire protocol, against a stubbed `fetch`. These cover the ways an
 * ArcGIS response can be wrong while looking fine — see `src/arcgis/README.md`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArcGisError, HttpError, requestJson } from '../src/arcgis/http.ts';
import { fetchLayerInfo } from '../src/arcgis/layer.ts';
import { IncompleteResponseError, queryByObjectIds, queryObjectIds } from '../src/arcgis/query.ts';
import { isRetryable } from '../src/retry.ts';

const URL = 'https://example.test/FeatureServer/0';

interface Call {
  url: string;
  params: URLSearchParams;
}

const calls: Call[] = [];

/** Answer every request with `body`, recording what was asked. */
function stubFetch(body: unknown, init: { status?: number; text?: string } = {}): void {
  vi.stubGlobal('fetch', async (url: string, options: { body: string }) => {
    calls.push({ url, params: new URLSearchParams(options.body) });
    const text = init.text ?? JSON.stringify(body);
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      text: async () => text,
    };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe('requestJson', () => {
  it('POSTs f=json and the given parameters', async () => {
    stubFetch({ ok: true });
    await requestJson(URL, { where: '1=1' });
    expect(calls[0]?.params.get('f')).toBe('json');
    expect(calls[0]?.params.get('where')).toBe('1=1');
  });

  it('raises an error that arrived with HTTP 200', async () => {
    // The response is a 200 with an error object in it, which is how ArcGIS
    // reports a bad field or a layer that wants a token.
    stubFetch({ error: { code: 400, message: 'Invalid field: STR_Number', details: ['bad'] } });
    await expect(requestJson(URL, {})).rejects.toThrow(ArcGisError);
    await expect(requestJson(URL, {})).rejects.toThrow(/Invalid field/);
  });

  it('raises a non-2xx response', async () => {
    stubFetch(null, { status: 503, text: 'Service Unavailable' });
    await expect(requestJson(URL, {})).rejects.toThrow(HttpError);
  });

  it('raises an HTML sign-in page rather than parsing it', async () => {
    stubFetch(null, { text: '<html><body>Sign in</body></html>' });
    await expect(requestJson(URL, {})).rejects.toThrow(/was not JSON/);
  });
});

describe('fetchLayerInfo', () => {
  it('reads the fields, page size and last-edit time', async () => {
    stubFetch({
      name: 'STR Registrations',
      geometryType: 'esriGeometryPoint',
      objectIdField: 'FID',
      maxRecordCount: 2000,
      fields: [{ name: 'FID', type: 'esriFieldTypeOID', alias: 'FID' }],
      editingInfo: { lastEditDate: 1_757_000_000_000 },
    });
    expect(await fetchLayerInfo(URL)).toMatchObject({
      name: 'STR Registrations',
      objectIdField: 'FID',
      maxRecordCount: 2000,
      lastEditMs: 1_757_000_000_000,
    });
  });

  it('finds the object-id field on a layer that does not declare one', async () => {
    stubFetch({
      fields: [
        { name: 'ESRI_OID', type: 'esriFieldTypeOID' },
        { name: 'STR_Number', type: 'esriFieldTypeString' },
      ],
    });
    expect((await fetchLayerInfo(URL)).objectIdField).toBe('ESRI_OID');
  });

  it('falls back to OBJECTID when the layer says nothing at all', async () => {
    stubFetch({ fields: [{ name: 'STR_Number', type: 'esriFieldTypeString' }] });
    const layer = await fetchLayerInfo(URL);
    expect(layer.objectIdField).toBe('OBJECTID');
    expect(layer.geometryType).toBeNull();
    expect(layer.maxRecordCount).toBeNull();
  });
});

describe('queryObjectIds', () => {
  it('returns the ids in ascending order', async () => {
    stubFetch({ objectIdFieldName: 'OBJECTID', objectIds: [3, 1, 2] });
    expect(await queryObjectIds(URL)).toEqual([1, 2, 3]);
    expect(calls[0]?.params.get('returnIdsOnly')).toBe('true');
  });

  it('reads a null id list as an empty layer', async () => {
    stubFetch({ objectIdFieldName: 'OBJECTID', objectIds: null });
    expect(await queryObjectIds(URL)).toEqual([]);
  });

  it('refuses a response that is not an id response', async () => {
    stubFetch({ features: [] });
    await expect(queryObjectIds(URL)).rejects.toThrow(IncompleteResponseError);
  });
});

describe('queryByObjectIds', () => {
  const feature = (id: number) => ({ attributes: { OBJECTID: id } });

  it('asks for the rows by id, with geometry in WGS84', async () => {
    stubFetch({ features: [feature(1), feature(2)] });
    expect(await queryByObjectIds(URL, [1, 2], true)).toHaveLength(2);
    expect(calls[0]?.params.get('objectIds')).toBe('1,2');
    expect(calls[0]?.params.get('outFields')).toBe('*');
    expect(calls[0]?.params.get('outSR')).toBe('4326');
  });

  it('omits outSR when it asks for no geometry', async () => {
    stubFetch({ features: [feature(1)] });
    await queryByObjectIds(URL, [1], false);
    expect(calls[0]?.params.get('returnGeometry')).toBe('false');
    expect(calls[0]?.params.has('outSR')).toBe(false);
  });

  it('raises a response the server flagged as truncated', async () => {
    stubFetch({ features: [feature(1)], exceededTransferLimit: true });
    await expect(queryByObjectIds(URL, [1], false)).rejects.toThrow(
      IncompleteResponseError,
    );
  });

  it('raises a short response the server did not flag', async () => {
    // The batch named two rows and got one. Without this the extract would
    // read as a registry that lost a record.
    stubFetch({ features: [feature(1)] });
    await expect(queryByObjectIds(URL, [1, 2], false)).rejects.toThrow(
      /returned 1 features for 2 object ids/,
    );
  });

  it('makes no request for an empty batch', async () => {
    stubFetch({ features: [] });
    expect(await queryByObjectIds(URL, [], false)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('isRetryable', () => {
  it('retries what a later attempt could answer', () => {
    expect(isRetryable(new HttpError(503, URL))).toBe(true);
    expect(isRetryable(new HttpError(429, URL))).toBe(true);
    expect(isRetryable(new ArcGisError(500, 'boom', URL))).toBe(true);
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
  });

  it('does not retry what will fail the same way again', () => {
    expect(isRetryable(new HttpError(400, URL))).toBe(false);
    expect(isRetryable(new HttpError(403, URL))).toBe(false);
    expect(isRetryable(new ArcGisError(400, 'Invalid field', URL))).toBe(false);
    // Asking again for the same oversized batch gets the same truncation;
    // `extract.ts` asks for fewer instead.
    expect(isRetryable(new IncompleteResponseError('truncated'))).toBe(false);
  });
});
