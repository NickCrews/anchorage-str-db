import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '../src/connect.ts';
import type { Database } from '../src/database.ts';
import { muniLicensePageReads, airbnbListingPhotos, muniStrRegistryRuns } from '../src/schema/index.ts';

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
        cityviewLicenseId: 13966,
        scrapeDate: '2026-09-14',
        licenseId: 'LC260500349',
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
        submittals: [{ name: '1 Private Detective 10/13/2026', type: 'Private Detective', date: '2026-10-13', status: 'Pending' }],
      },
    ]);

    expect(await db.rows('SELECT * FROM muni_license_page_reads')).toEqual([
      {
        cityview_license_id: 13966,
        scrape_date: '2026-09-14',
        license_id: 'LC260500349',
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
        submittals: [{ name: '1 Private Detective 10/13/2026', type: 'Private Detective', date: '2026-10-13', status: 'Pending' }],
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

  it('stages into a temporary table with the same columns', async () => {
    const db = await freshDb();
    await db.run('CREATE TEMP TABLE stg AS FROM airbnb_listing_photos LIMIT 0');
    await db.appendRows(
      airbnbListingPhotos,
      [{ listingId: 1n, validFrom: '2026-09-14', photoUrls: ['a.jpg', 'b.jpg'] }],
      { into: 'stg' },
    );

    expect(await db.rows('SELECT * FROM stg')).toEqual([
      { listing_id: '1', valid_from: '2026-09-14', photo_urls: ['a.jpg', 'b.jpg'] },
    ]);
    expect(await db.count('SELECT count(*) FROM airbnb_listing_photos')).toBe(0);
  });

  it('appends a subset of columns', async () => {
    const db = await freshDb();
    await db.run('CREATE TEMP TABLE stg AS SELECT listing_id, photo_urls FROM airbnb_listing_photos LIMIT 0');
    await db.appendRows(airbnbListingPhotos, [{ listingId: 1n, photoUrls: ['a.jpg'] }], {
      into: 'stg',
      columns: ['listingId', 'photoUrls'],
    });

    expect(await db.rows('SELECT * FROM stg')).toEqual([{ listing_id: '1', photo_urls: ['a.jpg'] }]);
  });

  it('rejects a target with a different number of columns', async () => {
    const db = await freshDb();
    await db.run('CREATE TEMP TABLE stg (listing_id BIGINT, photo_urls VARCHAR[])');

    await expect(
      db.appendRows(airbnbListingPhotos, [{ listingId: 1n, validFrom: '2026-09-14', photoUrls: [] }], {
        into: 'stg',
      }),
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
