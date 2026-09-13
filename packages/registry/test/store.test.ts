import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/db.ts';
import { normalizeRegistrationId } from '../src/fields.ts';
import type { RegistrationRecord } from '../src/records.ts';
import {
  connect,
  logRun,
  mergeRegistrations,
  OutOfOrderRunError,
  RegistryShrankError,
  type RunRow,
} from '../src/store.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A fresh on-disk database, so tests can reopen it to verify commits. */
async function freshDb(name = 't.duckdb'): Promise<{ db: Database; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-registry-'));
  temporary.push(dir);
  const path = join(dir, name);
  const db = await connect(path);
  open.push(db);
  return { db, path };
}

let nextObjectId = 1;

function record(
  registrationLabel: string,
  overrides: Partial<RegistrationRecord> = {},
): RegistrationRecord {
  const registrationId = normalizeRegistrationId(registrationLabel);
  const attributes = {
    STR_Number: registrationLabel,
    Status: overrides.status ?? 'Active',
    ...((overrides.attributes ?? {}) as Record<string, string | number | boolean | null>),
  };
  return {
    recordKey: registrationId ?? `oid#${nextObjectId}`,
    registrationId,
    registrationLabel,
    objectId: nextObjectId++,
    status: 'Active',
    registrationType: 'Whole home',
    address: '123 Alyeska Hwy',
    unit: null,
    zip: '99587',
    parcelId: '075-123-45-000',
    operatorName: 'A Host',
    issuedDate: '2026-05-12',
    expiresDate: '2027-05-12',
    editedDate: null,
    locationLat: 60.965,
    locationLng: -149.123,
    ...overrides,
    attributes,
    // Stand in for `records.ts`: any change to a stored attribute must give a
    // different hash, which is all the merge looks at.
    attrsHash: JSON.stringify([attributes, overrides.locationLat ?? 60.965]),
  };
}

function runRow(refreshDate: string, overrides: Partial<RunRow> = {}): RunRow {
  return {
    refreshDate,
    runStartedAt: `${refreshDate} 00:00:00`,
    runFinishedAt: `${refreshDate} 00:01:00`,
    serviceUrl: 'https://example.test/FeatureServer/0',
    layerLastEdit: `${refreshDate} 00:00:00`,
    recordsSeen: 1,
    recordsNew: 0,
    recordsChanged: 0,
    recordsRemoved: 0,
    unmappedFields: ['Notes'],
    errorSummary: null,
    ...overrides,
  };
}

interface VersionRow {
  record_key: string;
  status: string | null;
  valid_from: string;
  valid_to: string | null;
  is_current: boolean;
}

function versions(db: Database, key?: string): Promise<VersionRow[]> {
  return db.rows<VersionRow>(
    'SELECT record_key, status, valid_from, valid_to, is_current FROM str_registration_versions ' +
      (key === undefined ? '' : `WHERE record_key = '${key}' `) +
      'ORDER BY record_key, valid_from',
  );
}

describe('mergeRegistrations', () => {
  it('opens a version for every record on the first run', async () => {
    const { db } = await freshDb();
    const stats = await mergeRegistrations(db, '2026-09-01', [record('STR-1'), record('STR-2')]);

    expect(stats).toEqual({ seen: 2, new: 2, changed: 2, removed: 0 });
    expect(await versions(db)).toEqual([
      { record_key: 'STR1', status: 'Active', valid_from: '2026-09-01', valid_to: null, is_current: true },
      { record_key: 'STR2', status: 'Active', valid_from: '2026-09-01', valid_to: null, is_current: true },
    ]);
  });

  it('writes nothing on a day a record did not change', async () => {
    const { db } = await freshDb();
    await mergeRegistrations(db, '2026-09-01', [record('STR-1')]);
    const stats = await mergeRegistrations(db, '2026-09-02', [record('STR-1')]);

    expect(stats).toEqual({ seen: 1, new: 0, changed: 0, removed: 0 });
    // One interval, still open: the point of change-only storage.
    expect(await versions(db)).toEqual([
      { record_key: 'STR1', status: 'Active', valid_from: '2026-09-01', valid_to: null, is_current: true },
    ]);
  });

  it('closes the old version and opens a new one when a record changes', async () => {
    const { db } = await freshDb();
    await mergeRegistrations(db, '2026-09-01', [record('STR-1')]);
    const stats = await mergeRegistrations(db, '2026-09-05', [
      record('STR-1', { status: 'Expired' }),
    ]);

    expect(stats).toEqual({ seen: 1, new: 0, changed: 1, removed: 0 });
    expect(await versions(db)).toEqual([
      { record_key: 'STR1', status: 'Active', valid_from: '2026-09-01', valid_to: '2026-09-05', is_current: false },
      { record_key: 'STR1', status: 'Expired', valid_from: '2026-09-05', valid_to: null, is_current: true },
    ]);
  });

  it('closes a record that left the layer, without a successor', async () => {
    const { db } = await freshDb();
    await mergeRegistrations(db, '2026-09-01', [record('STR-1'), record('STR-2')]);
    const stats = await mergeRegistrations(db, '2026-09-05', [record('STR-1')]);

    expect(stats).toEqual({ seen: 1, new: 0, changed: 0, removed: 1 });
    const gone = await versions(db, 'STR2');
    expect(gone).toEqual([
      { record_key: 'STR2', status: 'Active', valid_from: '2026-09-01', valid_to: '2026-09-05', is_current: false },
    ]);
    // The view calls that a removal, and dates it.
    expect(
      await db.rows("SELECT record_key, removed_date FROM str_registrations WHERE record_key = 'STR2'"),
    ).toEqual([{ record_key: 'STR2', removed_date: '2026-09-05' }]);
  });

  it('reopens a registration that comes back as a new version', async () => {
    const { db } = await freshDb();
    await mergeRegistrations(db, '2026-09-01', [record('STR-1')]);
    await mergeRegistrations(db, '2026-09-02', []);
    await mergeRegistrations(db, '2026-09-03', [record('STR-1')]);

    expect(await versions(db, 'STR1')).toEqual([
      { record_key: 'STR1', status: 'Active', valid_from: '2026-09-01', valid_to: '2026-09-02', is_current: false },
      { record_key: 'STR1', status: 'Active', valid_from: '2026-09-03', valid_to: null, is_current: true },
    ]);
    expect(
      await db.rows("SELECT first_seen_date, removed_date FROM str_registrations_current WHERE record_key = 'STR1'"),
    ).toEqual([{ first_seen_date: '2026-09-01', removed_date: null }]);
  });

  it('replaces an earlier merge of the same date', async () => {
    const { db } = await freshDb();
    await mergeRegistrations(db, '2026-09-01', [record('STR-1'), record('STR-2')]);
    // A run that saw STR-2 as gone...
    await mergeRegistrations(db, '2026-09-05', [record('STR-1', { status: 'Expired' })]);
    // ...re-run the same day with the full layer.
    const stats = await mergeRegistrations(db, '2026-09-05', [record('STR-1'), record('STR-2')]);

    expect(stats).toEqual({ seen: 2, new: 0, changed: 0, removed: 0 });
    expect(await versions(db)).toEqual([
      { record_key: 'STR1', status: 'Active', valid_from: '2026-09-01', valid_to: null, is_current: true },
      { record_key: 'STR2', status: 'Active', valid_from: '2026-09-01', valid_to: null, is_current: true },
    ]);
  });

  it('refuses a run dated before the history it would land in', async () => {
    const { db } = await freshDb();
    await mergeRegistrations(db, '2026-09-05', [record('STR-1')]);
    await expect(mergeRegistrations(db, '2026-09-01', [record('STR-1')])).rejects.toThrow(
      OutOfOrderRunError,
    );
  });

  it('refuses to merge an extract far smaller than the last one', async () => {
    const { db } = await freshDb();
    const many = Array.from({ length: 100 }, (_, index) => record(`STR-${index}`));
    await mergeRegistrations(db, '2026-09-01', many);

    // Half the layer missing is a partial extract, not 50 removals.
    await expect(mergeRegistrations(db, '2026-09-02', many.slice(0, 50))).rejects.toThrow(
      RegistryShrankError,
    );
    // A few genuinely lapsing is fine.
    await expect(mergeRegistrations(db, '2026-09-02', many.slice(0, 95))).resolves.toMatchObject({
      removed: 5,
    });
  });

  it('lets an empty first run through, having nothing to lose', async () => {
    const { db } = await freshDb();
    await expect(mergeRegistrations(db, '2026-09-01', [])).resolves.toEqual({
      seen: 0,
      new: 0,
      changed: 0,
      removed: 0,
    });
  });

  it('keeps every attribute as JSON, including unmapped columns', async () => {
    const { db } = await freshDb();
    await mergeRegistrations(db, '2026-09-01', [
      record('STR-1', { attributes: { Bedroom_Count: 3 } as never }),
    ]);
    expect(
      await db.value("SELECT attributes->>'Bedroom_Count' FROM str_registration_versions"),
    ).toBe('3');
  });
});

describe('the run log', () => {
  it('round-trips a run, including a failed one', async () => {
    const { db } = await freshDb();
    await logRun(db, runRow('2026-09-01'));
    await logRun(
      db,
      runRow('2026-09-02', {
        runFinishedAt: null,
        recordsSeen: null,
        recordsNew: null,
        recordsChanged: null,
        recordsRemoved: null,
        unmappedFields: null,
        errorSummary: 'ArcGisError: ArcGIS error 400',
      }),
    );
    expect(
      await db.rows(
        'SELECT refresh_date, records_seen, unmapped_fields, error_summary FROM registry_runs ' +
          'ORDER BY refresh_date',
      ),
    ).toEqual([
      {
        refresh_date: '2026-09-01',
        records_seen: 1,
        unmapped_fields: ['Notes'],
        error_summary: null,
      },
      {
        refresh_date: '2026-09-02',
        records_seen: null,
        unmapped_fields: null,
        error_summary: 'ArcGisError: ArcGIS error 400',
      },
    ]);
  });
});

describe('the registration_key macro', () => {
  it('agrees with normalizeRegistrationId, which normalizes the other side', async () => {
    // The two implementations are the join. If they drift, a listing stops
    // matching its own registration and nothing else says so.
    const cases = [
      'STR-2026-0001',
      'str 2026 0001',
      ' STR20260001 ',
      'STR/2026/0001',
      '20260001',
      'N/A',
      'pending',
      '-',
      '',
    ];
    const { db } = await freshDb();
    const rows = await db.rows<{ value: string; key: string | null }>(
      `SELECT value, registration_key(value) AS key FROM (VALUES ${cases
        .map((value) => `('${value}')`)
        .join(', ')}) AS t(value)`,
    );
    expect(rows.map((row) => row.key)).toEqual(cases.map((value) => normalizeRegistrationId(value)));
  });
});
