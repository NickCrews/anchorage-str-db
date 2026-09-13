import { describe, expect, it } from 'vitest';

import type { LayerField } from '../src/arcgis/layer.ts';
import { mapFields, normalizeRegistrationId, unmappedFields } from '../src/fields.ts';

function field(name: string, type = 'esriFieldTypeString'): LayerField {
  return { name, type, alias: null, length: null };
}

describe('mapFields', () => {
  it('matches a layer field however it is punctuated or cased', () => {
    const map = mapFields([
      field('Site_Address'),
      field('STATUS'),
      field('registration number'),
      field('Parcel-ID'),
    ]);
    expect(map.address).toBe('Site_Address');
    expect(map.status).toBe('STATUS');
    expect(map.registrationId).toBe('registration number');
    expect(map.parcelId).toBe('Parcel-ID');
  });

  it('leaves a column null when the layer has nothing like it', () => {
    const map = mapFields([field('STR_NUMBER')]);
    expect(map.registrationId).toBe('STR_NUMBER');
    expect(map.parcelId).toBeNull();
    expect(map.operatorName).toBeNull();
  });

  it('prefers the earlier alias when a layer has several candidates', () => {
    // A CityView export carries both; the registration number is the one
    // meant for the public, and the permit number is its internal twin.
    const map = mapFields([field('PermitNumber'), field('RegistrationNumber')]);
    expect(map.registrationId).toBe('RegistrationNumber');
  });

  it('reports the fields no column claimed', () => {
    const fields = [field('STR_NUMBER'), field('Status'), field('SOMETHING_ELSE')];
    expect(unmappedFields(fields, mapFields(fields))).toEqual(['SOMETHING_ELSE']);
  });

  it('does not report the object-id field, which has a column of its own', () => {
    const fields = [field('OBJECTID', 'esriFieldTypeOID'), field('STR_NUMBER')];
    expect(unmappedFields(fields, mapFields(fields), 'OBJECTID')).toEqual([]);
  });
});

describe('normalizeRegistrationId', () => {
  it('reduces the same number written differently to one key', () => {
    for (const written of ['STR-2026-0001', 'str 2026 0001', ' STR20260001 ', 'STR/2026/0001']) {
      expect(normalizeRegistrationId(written)).toBe('STR20260001');
    }
  });

  it('takes a number the layer stored as a number', () => {
    expect(normalizeRegistrationId(20260001)).toBe('20260001');
  });

  it('rejects what hosts type where a number belongs', () => {
    // These must not become a key, or every listing claiming "pending" would
    // join to every other one.
    for (const text of ['', '  ', '-', 'N/A', 'n/a', 'none', 'pending', 'exempt']) {
      expect(normalizeRegistrationId(text)).toBeNull();
    }
  });

  it('rejects a value that is not text at all', () => {
    expect(normalizeRegistrationId(null)).toBeNull();
    expect(normalizeRegistrationId(undefined)).toBeNull();
    expect(normalizeRegistrationId({})).toBeNull();
  });
});
