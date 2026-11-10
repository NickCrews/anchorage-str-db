import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import type { HiddenLicensePage, LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';

import { runScan } from '../src/scan.ts';
import { latestReads, recordLicenseReads } from '../src/store.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-licenses-'));
  temporary.push(dir);
  return join(dir, 't.duckdb');
}

async function opened(path: string): Promise<Database> {
  const db = await connect(path);
  open.push(db);
  return db;
}

function licensePage(cityviewLicenseId: number, overrides: Partial<LicensePage> = {}): LicensePage {
  return {
    hidden: false,
    cityviewLicenseId,
    licenseId: `LC2605${String(cityviewLicenseId).padStart(5, '0')}`,
    businessName: 'Echo Ridge Mountain Retreat',
    licenseType: 'Short-Term Rentals',
    status: 'Active',
    description: 'Provides short term rentals, logistics, meeting space and overnight lodging.',
    locations: [{ label: 'Property', value: '07606227000', link: null }],
    issuances: [
      {
        type: 'STR Certificate',
        issuedDate: '2026-05-04',
        expiresDate: '2027-04-30',
        status: 'Active',
        number: 'STR20260309',
      },
    ],
    submittals: [],
    ...overrides,
  };
}

const hiddenPage = (cityviewLicenseId: number): HiddenLicensePage => ({ hidden: true, cityviewLicenseId });

describe('recordLicenseReads', () => {
  it('stores visible pages with their submittals, and hidden ids', async () => {
    const db = await opened(await freshPath());
    await recordLicenseReads(
      db,
      '2026-11-10',
      [
        licensePage(16427, {
          licenseType: 'Business',
          locations: [],
          submittals: [{ name: '1 Private Detective 10/13/2026', type: 'Private Detective', date: '2026-10-13', status: 'Pending' }],
        }),
      ],
      [hiddenPage(50)],
    );

    expect(await db.rows('SELECT cityview_license_id, locations, submittals FROM muni_license_page_reads')).toEqual([
      {
        cityview_license_id: 16427,
        locations: [],
        submittals: [{ name: '1 Private Detective 10/13/2026', type: 'Private Detective', date: '2026-10-13', status: 'Pending' }],
      },
    ]);
    expect(await db.rows('SELECT cityview_license_id, scrape_date FROM muni_license_hidden_reads')).toEqual([
      { cityview_license_id: 50, scrape_date: '2026-11-10' },
    ]);
  });

  it("replaces an id's earlier read that day, visible or hidden, and keeps the others", async () => {
    const db = await opened(await freshPath());
    await recordLicenseReads(db, '2026-11-10', [licensePage(1), licensePage(2)], [hiddenPage(3)]);
    await recordLicenseReads(db, '2026-11-10', [licensePage(3)], [hiddenPage(2)]);

    expect(await db.rows('SELECT cityview_license_id FROM muni_license_page_reads ORDER BY 1')).toEqual([
      { cityview_license_id: 1 },
      { cityview_license_id: 3 },
    ]);
    expect(await db.rows('SELECT cityview_license_id FROM muni_license_hidden_reads')).toEqual([
      { cityview_license_id: 2 },
    ]);
  });

  it('counts new licenses and changed statuses against earlier days', async () => {
    const db = await opened(await freshPath());
    const first = await recordLicenseReads(db, '2026-11-09', [licensePage(1), licensePage(2)], [hiddenPage(3)]);
    const expired = {
      issuances: [{ type: 'STR Certificate', issuedDate: null, expiresDate: null, status: 'Expired', number: null }],
    };
    const second = await recordLicenseReads(
      db,
      '2026-11-10',
      [licensePage(1), licensePage(2, expired), licensePage(3)],
      [],
    );
    // A re-run of the day counts the same.
    const again = await recordLicenseReads(
      db,
      '2026-11-10',
      [licensePage(1), licensePage(2, expired), licensePage(3)],
      [],
    );

    expect(first).toEqual({ licensesNew: 2, licensesStatusChanged: 0 });
    expect(second).toEqual({ licensesNew: 1, licensesStatusChanged: 1 });
    expect(again).toEqual(second);
  });
});

describe('latestReads', () => {
  it("gives each id's latest read and what it was", async () => {
    const db = await opened(await freshPath());
    await recordLicenseReads(db, '2026-11-08', [licensePage(1)], [hiddenPage(2)]);
    await recordLicenseReads(db, '2026-11-09', [licensePage(2, { licenseType: 'Alcohol' })], [hiddenPage(1)]);
    await recordLicenseReads(db, '2026-11-10', [], [hiddenPage(3)]);

    const reads = (await latestReads(db)).sort((a, b) => a.cityviewLicenseId - b.cityviewLicenseId);

    expect(reads).toEqual([
      { cityviewLicenseId: 1, scrapeDate: '2026-11-09', hidden: true, licenseType: null },
      { cityviewLicenseId: 2, scrapeDate: '2026-11-09', hidden: false, licenseType: 'Alcohol' },
      { cityviewLicenseId: 3, scrapeDate: '2026-11-10', hidden: true, licenseType: null },
    ]);
  });
});

describe('runScan', () => {
  /** Ids 1..6: even ids visible, odd hidden, and 5 fails. */
  const fetchOne = async (id: number) => {
    if (id === 5) throw new Error('timed out');
    return id % 2 === 0 ? licensePage(id) : hiddenPage(id);
  };

  it('reads the chosen ids, writes them and logs the scan', async () => {
    const path = await freshPath();
    const ok = await runScan({
      dbPath: path,
      scrapeDate: '2026-11-10',
      maxReads: 4,
      fetchNewest: async () => 6,
      fetchOne,
    });
    // The second scan picks up below the first, then retries the failed id.
    await runScan({ dbPath: path, scrapeDate: '2026-11-11', maxReads: 4, fetchNewest: async () => 6, fetchOne });

    const db = await opened(path);
    expect(await db.rows(
      'SELECT scrape_date, newest_cityview_license_id, pages_attempted, pages_read, hidden_read, ' +
        'pages_failed, licenses_new, error_summary FROM muni_license_runs ORDER BY scrape_date',
    )).toEqual([
      {
        scrape_date: '2026-11-10',
        newest_cityview_license_id: 6,
        pages_attempted: 4, // 6, 5, 4, 3
        pages_read: 2,
        hidden_read: 1,
        pages_failed: 1,
        licenses_new: 2,
        error_summary: null,
      },
      {
        scrape_date: '2026-11-11',
        newest_cityview_license_id: 6,
        // Never read: 5 (failed yesterday), 2, 1; then 3, hidden and read a day ago.
        pages_attempted: 4,
        pages_read: 1,
        hidden_read: 2,
        pages_failed: 1,
        licenses_new: 1,
        error_summary: null,
      },
    ]);
    // 1 of 4 reads failed: at the maximum rate, not over it.
    expect(ok).toBe(true);
  });

  it('fails when too many reads fail', async () => {
    const ok = await runScan({
      dbPath: await freshPath(),
      scrapeDate: '2026-11-10',
      fetchNewest: async () => 6,
      fetchOne: async (id) => {
        if (id > 3) throw new Error('timed out');
        return licensePage(id);
      },
    });
    expect(ok).toBe(false);
  });

  it('logs a failed scan after rolling back its writes', async () => {
    const path = await freshPath();
    await expect(
      runScan({
        dbPath: path,
        scrapeDate: '2026-11-10',
        fetchNewest: async () => {
          throw new Error('the License Locator is down');
        },
        fetchOne,
      }),
    ).rejects.toThrow(/License Locator is down/);

    const db = await opened(path);
    expect(await db.rows('SELECT pages_attempted, error_summary FROM muni_license_runs')).toEqual([
      { pages_attempted: null, error_summary: expect.stringMatching(/License Locator is down/) },
    ]);
  });

  it('passes its checks when every read succeeds', async () => {
    const path = await freshPath();
    const ok = await runScan({
      dbPath: path,
      scrapeDate: '2026-11-10',
      fetchNewest: async () => 4,
      fetchOne: async (id) => (id % 2 === 0 ? licensePage(id) : hiddenPage(id)),
    });
    expect(ok).toBe(true);
  });
});
