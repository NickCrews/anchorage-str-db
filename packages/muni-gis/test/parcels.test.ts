import { describe, expect, it } from 'vitest';

import type { FetchJson } from '../src/arcgis.ts';
import { BATCH_SIZE, fetchPropertyTypes } from '../src/parcels.ts';

describe('fetchPropertyTypes', () => {
  it('queries in batches and reports ids the layer lacks', async () => {
    const urls: string[] = [];
    const fetchJson: FetchJson = async (url) => {
      urls.push(url);
      const where = new URL(url).searchParams.get('where')!;
      const ids = [...where.matchAll(/'(\d+)'/g)].map((m) => m[1]!);
      return {
        features: ids
          .filter((id) => id !== '00000000000')
          .flatMap((id) => [
            { attributes: { Parcel_ID: id, Property_Type: id === '00000000001' ? null : 'RESIDENTIAL' } },
            // A repeated parcel id keeps its first row.
            { attributes: { Parcel_ID: id, Property_Type: 'CONDO' } },
          ]),
      };
    };
    const many = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => String(10_000_000_000 + i));

    const types = await fetchPropertyTypes(['00000000000', '00000000001', '07606227000', '07606227000', '076-062', ...many], fetchJson);

    expect(urls).toHaveLength(2);
    expect(types.slice(0, 3)).toEqual([
      { parcelId: '00000000000', found: false, propertyType: null },
      { parcelId: '00000000001', found: true, propertyType: null },
      { parcelId: '07606227000', found: true, propertyType: 'RESIDENTIAL' },
    ]);
    expect(types).toHaveLength(3 + many.length);
  });
});

describe('the live property information layer', () => {
  it("reads a parcel's Property_Type", async () => {
    expect(await fetchPropertyTypes(['07606227000', '99999999999'])).toEqual([
      { parcelId: '07606227000', found: true, propertyType: 'RESIDENTIAL' },
      { parcelId: '99999999999', found: false, propertyType: null },
    ]);
  });
});
