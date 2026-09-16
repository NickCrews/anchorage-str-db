import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pgTable } from 'drizzle-orm/pg-core';

import { bigint, day, varcharList } from '../src/columns.ts';
import { connect } from '../src/connect.ts';
import type { Database } from '../src/database.ts';
import { muniLicensePageReads, muniStrRegistryRuns } from '../src/schema.ts';

/** A staging table, declared the way `packages/scraper` declares its own. */
const stg = pgTable('stg', {
  listingId: bigint('listing_id'),
  validFrom: day('valid_from'),
  photoUrls: varcharList('photo_urls'),
});

const stgSubset = pgTable('stg_subset', {
  listingId: bigint('listing_id'),
  photoUrls: varcharList('photo_urls'),
});

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDb(): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-db-'));
  temporary.push(dir);
  const db = await connect(join(dir, 't.duckdb'));
  open.push(db);
  return db;
}

describe('appendRows', () => {
  it('writes dates, lists and structs of dates', async () => {
    const db = await freshDb();
    await db.appendRows(muniLicensePageReads, [
      {
        licenseId: 13966,
        scrapeDate: '2026-09-14',
        licenseeNumber: 'LC260500349',
        locations: [{ label: 'Property', value: '00123456789', link: null }],
        issuances: [
          {
            type: 'Registration',
            issued_date: '2026-05-01',
            expires_date: null,
            status: 'Issued',
            number: 'STR20260309',
          },
        ],
      },
    ]);

    expect(await db.rows('SELECT * FROM muni_license_page_reads')).toEqual([
      {
        license_id: 13966,
        scrape_date: '2026-09-14',
        licensee_number: 'LC260500349',
        business_name: null,
        license_type: null,
        status: null,
        description: null,
        locations: [{ label: 'Property', value: '00123456789', link: null }],
        issuances: [
          {
            type: 'Registration',
            issued_date: '2026-05-01',
            expires_date: null,
            status: 'Issued',
            number: 'STR20260309',
          },
        ],
      },
    ]);
  });

  it('writes naive UTC timestamps', async () => {
    const db = await freshDb();
    await db.appendRows(muniStrRegistryRuns, [
      { scrapeDate: '2026-09-14', runStartedAt: '2026-09-14 02:47:01', layerDataEditedAt: null },
    ]);

    expect(
      await db.rows(
        'SELECT run_started_at::VARCHAR AS started, layer_data_edited_at FROM muni_str_registry_runs',
      ),
    ).toEqual([{ started: '2026-09-14 02:47:01', layer_data_edited_at: null }]);
  });

  it('stages into a temporary table declared like any other', async () => {
    const db = await freshDb();
    await db.run('CREATE TEMP TABLE stg (listing_id BIGINT, valid_from DATE, photo_urls VARCHAR[])');
    await db.appendRows(stg, [
      { listingId: 1n, validFrom: '2026-09-14', photoUrls: ['a.jpg', 'b.jpg'] },
    ]);

    expect(await db.rows('SELECT * FROM stg')).toEqual([
      { listing_id: '1', valid_from: '2026-09-14', photo_urls: ['a.jpg', 'b.jpg'] },
    ]);
    expect(await db.count('SELECT count(*) FROM airbnb_listing_photos')).toBe(0);
  });

  it('appends the columns the staging table declares', async () => {
    const db = await freshDb();
    await db.run('CREATE TEMP TABLE stg_subset (listing_id BIGINT, photo_urls VARCHAR[])');
    await db.appendRows(stgSubset, [{ listingId: 1n, photoUrls: ['a.jpg'] }]);

    expect(await db.rows('SELECT * FROM stg_subset')).toEqual([
      { listing_id: '1', photo_urls: ['a.jpg'] },
    ]);
  });

  it('rejects a target with a different number of columns', async () => {
    const db = await freshDb();
    await db.run('CREATE TEMP TABLE stg (listing_id BIGINT, photo_urls VARCHAR[])');

    await expect(
      db.appendRows(stg, [{ listingId: 1n, validFrom: '2026-09-14', photoUrls: [] }]),
    ).rejects.toThrow('`stg` has 2 columns; 3 are being appended');
  });
});

describe('orm', () => {
  it('inserts through the same transaction as raw statements', async () => {
    const db = await freshDb();
    await expect(
      db.transaction(async () => {
        await db.orm.insert(muniStrRegistryRuns).values({
          scrapeDate: '2026-09-14',
          runStartedAt: '2026-09-14 02:47:01',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await db.count('SELECT count(*) FROM muni_str_registry_runs')).toBe(0);
  });
});
