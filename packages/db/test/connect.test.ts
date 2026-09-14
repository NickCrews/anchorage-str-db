import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect, LegacySchemaError } from '../src/connect.ts';
import { Database } from '../src/database.ts';

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
    expect(await db.count('SELECT count(*) FROM listings_current_with_registration')).toBe(0);
    expect(await db.count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(1);
  });

  it('applies each migration once across reopens', async () => {
    const path = await tempPath();
    (await connect(path)).close();
    const db = await connected(path);

    expect(await db.count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(1);
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
    expect(await db.count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(1);
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
