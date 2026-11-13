import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect, LegacySchemaError } from '../src/connect.ts';
import { Database } from '../src/database.ts';

/** Migrations in `../drizzle`; every `connect` should end with exactly these applied. */
const MIGRATION_COUNT = 6;

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-db-'));
  temporary.push(dir);
  return join(dir, 't.duckdb');
}

/** A file with `sql` run in it and nothing else. */
async function preexisting(sql: string): Promise<string> {
  const path = await tempPath();
  const db = await Database.open(path);
  await db.run(sql);
  db.close();
  return path;
}

async function connected(path: string): Promise<Database> {
  const db = await connect(path);
  open.push(db);
  return db;
}

describe('connect', () => {
  it('creates the tables and views in an empty database', async () => {
    const db = await connected(await tempPath());

    expect(await db.count('SELECT count(*) FROM airbnb_listing_observations')).toBe(0);
    expect(await db.count('SELECT count(*) FROM listings_active_with_registration')).toBe(0);
    expect(await db.count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(MIGRATION_COUNT);
  });

  it('drops a view left under a name the views no longer create', async () => {
    // A published database keeps every view it was ever given: CREATE OR
    // REPLACE cannot remove one, so a rename leaves the old name answering
    // queries from a definition nothing maintains.
    const db = await connected(
      await preexisting('CREATE VIEW host_portfolios AS SELECT 1 AS host_id;'),
    );

    expect(
      await db.count("SELECT count(*) FROM duckdb_views() WHERE view_name = 'host_portfolios'"),
    ).toBe(0);
    expect(
      await db.count(
        "SELECT count(*) FROM duckdb_views() WHERE view_name = 'host_listing_portfolios'",
      ),
    ).toBe(1);
  });

  it('applies each migration once across reopens', async () => {
    const path = await tempPath();
    (await connect(path)).close();
    const db = await connected(path);

    expect(await db.count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(MIGRATION_COUNT);
  });

  it('adopts tables that already match the schema', async () => {
    const baseline = await readFile(
      new URL('../drizzle/0000_baseline.sql', import.meta.url),
      'utf8',
    );
    const path = await preexisting(baseline.replaceAll('--> statement-breakpoint', ''));
    const seed = await Database.open(path);
    await seed.run(
      "INSERT INTO airbnb_scrape_runs (scrape_date, run_started_at, listings_seen) " +
        "VALUES ('2026-08-31', '2026-08-31 12:00:00', 5)",
    );
    seed.close();

    const db = await connected(path);

    expect(await db.rows('SELECT scrape_date, listings_seen FROM airbnb_scrape_runs')).toEqual([
      { scrape_date: '2026-08-31', listings_seen: 5 },
    ]);
    expect(await db.count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(MIGRATION_COUNT);
  });

  it('renames the published columns and keeps the rows', async () => {
    const baseline = await readFile(
      new URL('../drizzle/0000_baseline.sql', import.meta.url),
      'utf8',
    );
    const path = await preexisting(baseline.replaceAll('--> statement-breakpoint', ''));
    const seed = await Database.open(path);
    // Written under the names 0000 creates, as the published database has them.
    await seed.run(
      "INSERT INTO muni_str_registration_observations " +
        "(registration_number, scrape_date, application_number, location, business_name, status) " +
        "VALUES ('STR20260309', '2026-09-14', 'LC260500349', '257 ECHO RIDGE DR', 'Echo LLC', 'Active')",
    );
    await seed.run(
      "INSERT INTO airbnb_listing_observations " +
        "(listing_id, scrape_date, name, location_lat, location_lng, page_fetch_ok, " +
        "str_registration_id, room_type) " +
        "VALUES (1, '2026-09-14', 'Cabin A', 61.1, -149.9, true, 'STR20260309', 'Entire home/apt')",
    );
    await seed.run(
      "INSERT INTO muni_str_registry_runs " +
        "(scrape_date, run_started_at, registrations_seen, registrations_departed) " +
        "VALUES ('2026-09-14', '2026-09-14 12:00:00', 1, 0)",
    );
    await seed.run(
      "INSERT INTO muni_license_page_reads " +
        "(license_id, scrape_date, licensee_number, business_name, locations, issuances) " +
        "VALUES (13923, '2026-09-14', 'LC260500349', 'Echo LLC', [], [])",
    );
    seed.close();

    const db = await connected(path);

    expect(
      await db.rows(
        'SELECT registration_id, license_id, registered_address FROM registrations',
      ),
    ).toEqual([
      {
        registration_id: 'STR20260309',
        license_id: 'LC260500349',
        registered_address: '257 ECHO RIDGE DR',
      },
    ]);
    expect(
      await db.rows(
        'SELECT registration_id, registration_found FROM listings_active_with_registration',
      ),
    ).toEqual([{ registration_id: 'STR20260309', registration_found: true }]);
    expect(
      await db.rows('SELECT registrations_lapsed FROM muni_str_registry_runs'),
    ).toEqual([{ registrations_lapsed: 0 }]);
    // 0002 swaps the two: CityView's row id steps aside for the LC id.
    expect(
      await db.rows(
        'SELECT cityview_license_id, license_id FROM muni_license_page_reads',
      ),
    ).toEqual([{ cityview_license_id: 13923, license_id: 'LC260500349' }]);
    // 0003: Airbnb's word for it was room_type.
    expect(
      await db.rows('SELECT listing_type FROM listings WHERE is_active'),
    ).toEqual([{ listing_type: 'Entire home/apt' }]);
    // 0004: a read stored before submittals were has none recorded.
    expect(
      await db.rows('SELECT submittals FROM muni_license_page_reads'),
    ).toEqual([{ submittals: null }]);
    expect(await db.count('SELECT count(*) FROM muni_license_hidden_reads')).toBe(0);
    expect(await db.count('SELECT count(*) FROM muni_license_runs')).toBe(0);
    // 0005: the geocode table starts empty.
    expect(await db.count('SELECT count(*) FROM muni_address_geocodes')).toBe(0);
  });

  it('rejects a database with listings as a table', async () => {
    const path = await preexisting('CREATE TABLE listings (listing_id BIGINT, is_current BOOLEAN)');

    await expect(connect(path)).rejects.toThrow(LegacySchemaError);
    await expect(connect(path)).rejects.toThrow(/tables the schema does not declare: `listings`/);
  });

  it('rejects tables named without their source prefix', async () => {
    const path = await preexisting(
      'CREATE TABLE scrape_runs (scrape_date DATE); CREATE TABLE registry_runs (scrape_date DATE)',
    );

    await expect(connect(path)).rejects.toThrow(
      'tables the schema does not declare: `registry_runs`, `scrape_runs`',
    );
  });

  it('rejects a table missing a column', async () => {
    const path = await preexisting(
      'CREATE TABLE airbnb_listing_first_reviews (listing_id BIGINT PRIMARY KEY, resolved_date DATE NOT NULL)',
    );

    await expect(connect(path)).rejects.toThrow(
      '`airbnb_listing_first_reviews` column 2 is `resolved_date DATE NOT NULL`, not `first_review_date DATE`',
    );
  });

  it('rejects a struct column with different fields', async () => {
    // Column names as `0000_baseline` creates them, since this file records no
    // migration and the renames run over it on the way through.
    const path = await preexisting(`
      CREATE TABLE muni_license_page_reads (
          license_id INTEGER NOT NULL,
          scrape_date DATE NOT NULL,
          licensee_number VARCHAR NOT NULL,
          business_name VARCHAR,
          license_type VARCHAR,
          status VARCHAR,
          description VARCHAR,
          locations STRUCT(label VARCHAR, value VARCHAR)[] NOT NULL,
          issuances STRUCT(
              type VARCHAR, issued_date DATE, expires_date DATE, status VARCHAR, number VARCHAR
          )[] NOT NULL,
          PRIMARY KEY (license_id, scrape_date)
      )
    `);

    await expect(connect(path)).rejects.toThrow(/`muni_license_page_reads` column 8 is `locations/);
  });
});
