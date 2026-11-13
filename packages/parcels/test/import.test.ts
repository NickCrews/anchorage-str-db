/**
 * The parcel import against a local DuckDB file shaped like
 * anchorage-property's `anchorage-current.duckdb`. No network.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import { Database } from '@anchorage-str-db/db/database';

import { MIN_PARCELS } from '../src/checks.ts';
import { main } from '../src/cli.ts';
import { runImport } from '../src/import.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-parcels-'));
  temporary.push(dir);
  return dir;
}

async function opened(path: string): Promise<Database> {
  const db = await connect(path);
  open.push(db);
  return db;
}

interface SourceShape {
  /** Parcels in parcels_current: '00000000000', '00000000001', .... */
  parcels?: number;
  /** Extra rows appended verbatim, e.g. a duplicate. */
  extraSql?: string;
  /** Columns left out of parcels_current. */
  without?: string[];
  /** Whether the file has ingest_runs. */
  ingestRuns?: boolean;
}

/** Columns of parcels_current, a subset in the source's order and types, plus one this repo does not import. */
const SOURCE_COLUMNS: [string, string][] = [
  ['parcel_id', "lpad(i::VARCHAR, 11, '0')"],
  ['property_type', "CASE WHEN i % 5 = 0 THEN 'CONDO' ELSE 'RESIDENTIAL' END"],
  ['land_use', "'Residential 1 Family'"],
  ['owner_name', "'SOMEONE'"],
  ['parcel_address', "i::VARCHAR || ' ECHO RIDGE DR'"],
  ['total_living_units', '(i % 3)::INTEGER'],
  ['zoning_district', "'R1'"],
  ['valid_from', "TIMESTAMP '2026-10-07 19:37:33.788'"],
  ['centroid_lon', '-149.9'],
  ['centroid_lat', '61.2'],
];

/** Write a source database and return its path. */
async function sourceFile(shape: SourceShape = {}): Promise<string> {
  const path = join(await tempDir(), 'anchorage-current.duckdb');
  const db = await Database.open(path);
  const columns = SOURCE_COLUMNS.filter(([name]) => !shape.without?.includes(name));
  await db.run(
    'CREATE TABLE parcels_current AS SELECT ' +
      columns.map(([name, sql]) => `${sql} AS ${name}`).join(', ') +
      ` FROM range(${shape.parcels ?? MIN_PARCELS}) t(i)`,
  );
  if (shape.extraSql) await db.run(shape.extraSql);
  if (shape.ingestRuns ?? true) {
    await db.run(
      'CREATE TABLE ingest_runs (run_id VARCHAR, started_at TIMESTAMP, finished_at TIMESTAMP, status VARCHAR, distinct_parcels BIGINT)',
    );
    await db.run(
      "INSERT INTO ingest_runs VALUES " +
        "('2026-11-12-73ed2486', '2026-11-12 21:12:00.058', '2026-11-12 21:12:16', 'success', 98571), " +
        "('2026-11-13-d1a8fba8', '2026-11-13 20:41:09.462', '2026-11-13 20:41:26', 'success', 98571), " +
        "('2026-11-14-00000000', '2026-11-14 20:00:00', NULL, 'failed', NULL)",
    );
  }
  db.close();
  return path;
}

async function dbPath(): Promise<string> {
  return join(await tempDir(), 't.duckdb');
}

async function imports(path: string): Promise<unknown[]> {
  const db = await opened(path);
  const rows = await db.rows(
    'SELECT import_date, parcels_imported, source_ingest_run, error_summary FROM property_parcel_imports ORDER BY run_started_at, import_date',
  );
  db.close();
  open.pop();
  return rows;
}

describe('runImport', () => {
  it('copies every parcel and logs the import', async () => {
    const path = await dbPath();

    expect(await runImport({ dbPath: path, importDate: '2026-11-14', sourceUrl: await sourceFile() })).toBe(true);

    const db = await opened(path);
    expect(await db.count('SELECT count(*) FROM property_parcels')).toBe(MIN_PARCELS);
    expect(await db.rows("SELECT * FROM property_parcels WHERE parcel_id = '00000000005'")).toEqual([
      {
        parcel_id: '00000000005',
        parcel_address: '5 ECHO RIDGE DR',
        property_type: 'CONDO',
        total_living_units: 2,
        land_use: 'Residential 1 Family',
        zoning_district: 'R1',
        centroid_lat: 61.2,
        centroid_lon: -149.9,
        valid_from: '2026-10-07 19:37:33.788',
        imported_date: '2026-11-14',
      },
    ]);
    expect(
      await db.rows('SELECT import_date, parcels_imported, source_ingest_run, error_summary FROM property_parcel_imports'),
    ).toEqual([
      { import_date: '2026-11-14', parcels_imported: MIN_PARCELS, source_ingest_run: '2026-11-13-d1a8fba8', error_summary: null },
    ]);
  });

  it('replaces the whole table each import', async () => {
    const path = await dbPath();
    await runImport({ dbPath: path, importDate: '2026-11-13', sourceUrl: await sourceFile({ parcels: MIN_PARCELS + 1 }) });
    await runImport({ dbPath: path, importDate: '2026-11-14', sourceUrl: await sourceFile() });

    const db = await opened(path);
    expect(
      await db.rows('SELECT count(*)::INTEGER AS n, min(imported_date) AS first, max(parcel_id) AS last FROM property_parcels'),
    ).toEqual([{ n: MIN_PARCELS, first: '2026-11-14', last: lpad(MIN_PARCELS - 1) }]);
    // Recreated with its primary key.
    expect(
      await db.count(
        "SELECT count(*) FROM duckdb_constraints() WHERE table_name = 'property_parcels' AND constraint_type = 'PRIMARY KEY'",
      ),
    ).toBe(1);
    expect(await db.count('SELECT count(*) FROM licenses')).toBe(0);
  });

  it('records no ingest run for a source without ingest_runs', async () => {
    const path = await dbPath();

    expect(
      await runImport({ dbPath: path, importDate: '2026-11-14', sourceUrl: await sourceFile({ ingestRuns: false }) }),
    ).toBe(true);
    expect(await imports(path)).toEqual([
      { import_date: '2026-11-14', parcels_imported: MIN_PARCELS, source_ingest_run: null, error_summary: null },
    ]);
  });

  describe('refuses a source that looks wrong and keeps the table', () => {
    async function afterRefusal(source: SourceShape, check: string): Promise<void> {
      const path = await dbPath();
      await runImport({ dbPath: path, importDate: '2026-11-13', sourceUrl: await sourceFile() });

      expect(await runImport({ dbPath: path, importDate: '2026-11-14', sourceUrl: await sourceFile(source) })).toBe(false);

      const db = await opened(path);
      expect(
        await db.rows('SELECT count(*)::INTEGER AS n, max(imported_date) AS imported FROM property_parcels'),
      ).toEqual([{ n: MIN_PARCELS, imported: '2026-11-13' }]);
      const [failed] = await db.rows<{ parcels_imported: number | null; error_summary: string }>(
        "SELECT parcels_imported, error_summary FROM property_parcel_imports WHERE import_date = '2026-11-14'",
      );
      expect(failed?.parcels_imported).toBeNull();
      expect(failed?.error_summary).toContain(check);
    }

    it(`with fewer than ${MIN_PARCELS} parcels`, () => afterRefusal({ parcels: MIN_PARCELS - 1 }, 'parcel_count'));

    it('with a duplicate parcel id', () =>
      afterRefusal(
        { extraSql: "INSERT INTO parcels_current BY NAME SELECT '00000000007' AS parcel_id" },
        'parcel_id_unique',
      ));

    it('with a missing parcel id', () =>
      afterRefusal({ extraSql: 'INSERT INTO parcels_current BY NAME SELECT NULL AS parcel_id' }, 'parcel_id_unique'));

    it('with a missing column', () => afterRefusal({ without: ['zoning_district'] }, 'parcel_source_columns'));

    it('without parcels_current', () =>
      afterRefusal({ parcels: 0, extraSql: 'DROP TABLE parcels_current' }, 'parcel_source_columns'));
  });

  it('logs a source it cannot open, and throws', async () => {
    const path = await dbPath();
    const missing = join(await tempDir(), 'nowhere.duckdb');

    await expect(runImport({ dbPath: path, importDate: '2026-11-14', sourceUrl: missing })).rejects.toThrow();

    const [row] = await imports(path);
    expect(row).toMatchObject({ import_date: '2026-11-14', parcels_imported: null, source_ingest_run: null });
    expect((row as { error_summary: string }).error_summary).toBeTruthy();
  });
});

describe('main', () => {
  it('imports from --source', async () => {
    const path = await dbPath();

    expect(await main(['--db', path, '--date', '2026-11-14', '--source', await sourceFile(), 'import'])).toBe(0);
    expect(await imports(path)).toHaveLength(1);
  });

  it('rejects an unknown command and a malformed date', async () => {
    expect(await main(['--db', await dbPath(), 'scan'])).toBe(2);
    expect(await main(['--db', await dbPath(), '--date', '14/11/2026', 'import'])).toBe(2);
  });
});

function lpad(n: number): string {
  return String(n).padStart(11, '0');
}
