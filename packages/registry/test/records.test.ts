import { describe, expect, it } from 'vitest';

import type { Feature } from '../src/arcgis/query.ts';
import { mapFields, type FieldMap } from '../src/fields.ts';
import { duplicateRegistrationIds, toRecords } from '../src/records.ts';

const FIELD_MAP: FieldMap = mapFields([
  { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: null, length: null },
  { name: 'STR_Number', type: 'esriFieldTypeString', alias: null, length: null },
  { name: 'Status', type: 'esriFieldTypeString', alias: null, length: null },
  { name: 'Site_Address', type: 'esriFieldTypeString', alias: null, length: null },
  { name: 'ParcelID', type: 'esriFieldTypeString', alias: null, length: null },
  { name: 'IssueDate', type: 'esriFieldTypeDate', alias: null, length: null },
  { name: 'ExpirationDate', type: 'esriFieldTypeDate', alias: null, length: null },
]);

function feature(overrides: Record<string, unknown> = {}, geometry?: Feature['geometry']): Feature {
  return {
    attributes: {
      OBJECTID: 1,
      STR_Number: 'STR-2026-0001',
      Status: 'Active',
      Site_Address: '123 Alyeska Hwy',
      ParcelID: '075-123-45-000',
      IssueDate: Date.UTC(2026, 4, 12),
      ExpirationDate: Date.UTC(2027, 4, 12),
      ...overrides,
    },
    ...(geometry === undefined ? {} : { geometry }),
  };
}

function only(features: Feature[]) {
  const records = toRecords(features, FIELD_MAP, 'OBJECTID');
  const record = records[0];
  if (!record) throw new Error('expected a record');
  return record;
}

describe('toRecords', () => {
  it('maps the columns and normalizes the registration number', () => {
    const record = only([feature()]);
    expect(record.registrationId).toBe('STR20260001');
    expect(record.registrationLabel).toBe('STR-2026-0001');
    expect(record.recordKey).toBe('STR20260001');
    expect(record.status).toBe('Active');
    expect(record.address).toBe('123 Alyeska Hwy');
    expect(record.parcelId).toBe('075-123-45-000');
    expect(record.issuedDate).toBe('2026-05-12');
    expect(record.expiresDate).toBe('2027-05-12');
  });

  it('reads a point geometry as lat/lng, and null island as no coordinate', () => {
    expect(only([feature({}, { x: -149.12, y: 60.96 })])).toMatchObject({
      locationLng: -149.12,
      locationLat: 60.96,
    });
    expect(only([feature({}, { x: 0, y: 0 })])).toMatchObject({
      locationLng: null,
      locationLat: null,
    });
    expect(only([feature()])).toMatchObject({ locationLng: null, locationLat: null });
  });

  it('trims text and reads a blank cell as null', () => {
    const record = only([feature({ Site_Address: '  123 Alyeska Hwy  ', Status: '   ' })]);
    expect(record.address).toBe('123 Alyeska Hwy');
    expect(record.status).toBeNull();
    expect(record.attributes.Status).toBeNull();
  });

  it('keeps every attribute, including ones no column claimed', () => {
    const record = only([feature({ Bedroom_Count: 3 })]);
    expect(record.attributes.Bedroom_Count).toBe(3);
    expect(record.attributes.STR_Number).toBe('STR-2026-0001');
  });
});

describe('the version hash', () => {
  it('is the same for the same record read twice', () => {
    expect(only([feature()]).attrsHash).toBe(only([feature()]).attrsHash);
  });

  it('does not depend on the order the server serialized the attributes in', () => {
    const forward = only([feature()]);
    const reversed = only([
      {
        attributes: Object.fromEntries(Object.entries(feature().attributes).reverse()),
      },
    ]);
    expect(reversed.attrsHash).toBe(forward.attrsHash);
  });

  it('changes when a stored attribute changes', () => {
    expect(only([feature({ Status: 'Expired' })]).attrsHash).not.toBe(only([feature()]).attrsHash);
  });

  it('changes when an unmapped attribute changes', () => {
    // Nothing in FIELD_ALIASES claims this column, so only the raw-attribute
    // hash can notice it move.
    expect(only([feature({ Bedroom_Count: 3 })]).attrsHash).not.toBe(
      only([feature({ Bedroom_Count: 4 })]).attrsHash,
    );
  });

  it('changes when the point moves, but not for sub-centimetre noise', () => {
    const base = only([feature({}, { x: -149.123456, y: 60.965432 })]).attrsHash;
    expect(only([feature({}, { x: -149.1234561, y: 60.965432 })]).attrsHash).toBe(base);
    expect(only([feature({}, { x: -149.1235, y: 60.965432 })]).attrsHash).not.toBe(base);
  });

  it('ignores the object id and Esri housekeeping columns', () => {
    // A truncate-and-append republish rewrites all of these for every row
    // without a registration having changed. Hashing them would re-version
    // the whole registry that day.
    const base = only([feature()]).attrsHash;
    expect(
      only([
        feature({
          OBJECTID: 9999,
          GlobalID: '{NEW-GUID}',
          EditDate: Date.UTC(2026, 8, 1),
          last_edited_user: 'someone',
          'Shape__Area': 123,
        }),
      ]).attrsHash,
    ).toBe(base);
  });
});

describe('record keys', () => {
  it('falls back to the object id when a record has no readable number', () => {
    const record = only([feature({ STR_Number: 'pending', OBJECTID: 42 })]);
    expect(record.registrationId).toBeNull();
    expect(record.recordKey).toBe('oid#42');
  });

  it('keeps two records sharing a number apart', () => {
    const records = toRecords(
      [feature({ OBJECTID: 1 }), feature({ OBJECTID: 2, Site_Address: 'Unit B' })],
      FIELD_MAP,
      'OBJECTID',
    );
    expect(records.map((record) => record.recordKey)).toEqual([
      'STR20260001#1',
      'STR20260001#2',
    ]);
    expect(duplicateRegistrationIds(records)).toEqual(['STR20260001']);
  });

  it('reports no duplicates when every number is its own', () => {
    const records = toRecords(
      [feature({ OBJECTID: 1 }), feature({ OBJECTID: 2, STR_Number: 'STR-2026-0002' })],
      FIELD_MAP,
      'OBJECTID',
    );
    expect(duplicateRegistrationIds(records)).toEqual([]);
    expect(records.map((record) => record.recordKey)).toEqual(['STR20260001', 'STR20260002']);
  });
});
