import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import type { CouncilPolygon } from '@anchorage-str-db/muni-gis-client/councils';
import type { GeocodeCandidate } from '@anchorage-str-db/muni-gis-client/geocoder';
import type { HiddenLicensePage, LicensePage } from '@anchorage-str-db/licenses-client/licensePage';

import type { GisClients } from '../src/geocode.ts';
import { scrapeLicenses } from '../src/scrape.ts';
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

/** One council over all of Anchorage, and a square of sea west of it that no council covers. */
const COUNCILS: CouncilPolygon[] = [
  { council: 'Downtown', rings: [[[-150, 60], [-150, 62], [-149, 62], [-149, 60], [-150, 60]]] },
];

/**
 * Offline GIS: an address with 'nowhere' in it has no candidate, one with
 * 'street' only a street, 'sea' is placed outside every council, and one
 * containing `failing` fails.
 */
function fakeGis(asked: string[] = [], failing = 'boom'): GisClients {
  return {
    fetchCouncils: async () => COUNCILS,
    geocodeOne: async (address): Promise<GeocodeCandidate | null> => {
      asked.push(address);
      if (address.includes(failing)) throw new Error('HTTP 500');
      if (address.includes('nowhere')) return null;
      return {
        matchedAddress: address.toUpperCase(),
        lat: 61.2,
        lng: address.includes('sea') ? -151 : -149.9,
        score: 100,
        matchType: address.includes('street') ? 'StreetName' : 'PointAddress',
      };
    },
  };
}

const at = (address: string) => [{ label: 'Address', value: address, link: null }];

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

describe('scrapeLicenses', () => {
  /** Ids 1..6: even ids visible, odd hidden, and 5 fails. */
  const fetchOne = async (id: number) => {
    if (id === 5) throw new Error('timed out');
    return id % 2 === 0 ? licensePage(id) : hiddenPage(id);
  };

  it('reads the chosen ids, writes them and logs the scrape', async () => {
    const path = await freshPath();
    const ok = await scrapeLicenses({
      dbPath: path,
      scrapeDate: '2026-11-10',
      maxReads: 4,
      fetchNewest: async () => 6,
      fetchOne,
      gis: fakeGis(),
    });
    // The second scrape picks up below the first, then retries the failed id.
    await scrapeLicenses({
      dbPath: path,
      scrapeDate: '2026-11-11',
      maxReads: 4,
      fetchNewest: async () => 6,
      fetchOne,
      gis: fakeGis(),
    });

    const db = await opened(path);
    expect(await db.rows(
      'SELECT scrape_date, newest_cityview_license_id, pages_attempted, pages_read, hidden_read, ' +
        'pages_failed, licenses_new, error_summary FROM muni_license_scrape_runs ORDER BY scrape_date',
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
    const ok = await scrapeLicenses({
      dbPath: await freshPath(),
      scrapeDate: '2026-11-10',
      fetchNewest: async () => 6,
      fetchOne: async (id) => {
        if (id > 3) throw new Error('timed out');
        return licensePage(id);
      },
      gis: fakeGis(),
    });
    expect(ok).toBe(false);
  });

  it('logs a failed scrape after rolling back its writes', async () => {
    const path = await freshPath();
    await expect(
      scrapeLicenses({
        dbPath: path,
        scrapeDate: '2026-11-10',
        fetchNewest: async () => {
          throw new Error('the License Locator is down');
        },
        fetchOne,
        gis: fakeGis(),
      }),
    ).rejects.toThrow(/License Locator is down/);

    const db = await opened(path);
    expect(await db.rows('SELECT pages_attempted, error_summary FROM muni_license_scrape_runs')).toEqual([
      { pages_attempted: null, error_summary: expect.stringMatching(/License Locator is down/) },
    ]);
  });

  it('passes its checks when every read succeeds', async () => {
    const path = await freshPath();
    const ok = await scrapeLicenses({
      dbPath: path,
      scrapeDate: '2026-11-10',
      fetchNewest: async () => 4,
      fetchOne: async (id) => (id % 2 === 0 ? licensePage(id) : hiddenPage(id)),
      gis: fakeGis(),
    });
    expect(ok).toBe(true);
  });
});

describe('the geocoding pass', () => {
  /** Ids 1..6, each at its own address; 6 is a private detective license with none. */
  const pages: Record<number, LicensePage> = {
    1: licensePage(1, { locations: at('1 nowhere st') }),
    2: licensePage(2, { locations: at('2 street only') }),
    3: licensePage(3, { locations: at('3 boom ave') }),
    4: licensePage(4, { locations: [{ label: 'Property', value: '00606148000', link: null }, ...at('4 sea view')] }),
    5: licensePage(5, { licenseType: 'Alcohol', locations: at('5 W 4th Ave') }),
    6: licensePage(6, { licenseType: 'Business', locations: [] }),
  };
  const scrape = (path: string, scrapeDate: string, gis: GisClients) =>
    scrapeLicenses({
      dbPath: path,
      scrapeDate,
      fetchNewest: async () => 6,
      fetchOne: async (id) => pages[id]!,
      gis,
    });

  it("geocodes every license's address once, keeping misses", async () => {
    const path = await freshPath();
    const asked: string[] = [];
    const ok = await scrape(path, '2026-11-10', fakeGis(asked));
    // The next day asks only about the address whose request failed, and it answers.
    const askedNextDay: string[] = [];
    await scrape(path, '2026-11-11', fakeGis(askedNextDay, 'no failures'));

    const db = await opened(path);
    expect(asked.sort()).toEqual(['1 nowhere st', '2 street only', '3 boom ave', '4 sea view', '5 W 4th Ave']);
    expect(askedNextDay).toEqual(['3 boom ave']);
    expect(
      await db.rows(
        'SELECT address, geocoded_date, matched_address, community_council, score, match_type ' +
          'FROM muni_address_geocodes ORDER BY address',
      ),
    ).toEqual([
      { address: '1 nowhere st', geocoded_date: '2026-11-10', matched_address: null, community_council: null, score: null, match_type: null },
      // The street alone is a candidate, not a match.
      { address: '2 street only', geocoded_date: '2026-11-10', matched_address: null, community_council: null, score: 100, match_type: 'StreetName' },
      { address: '3 boom ave', geocoded_date: '2026-11-11', matched_address: '3 BOOM AVE', community_council: 'Downtown', score: 100, match_type: 'PointAddress' },
      { address: '4 sea view', geocoded_date: '2026-11-10', matched_address: '4 SEA VIEW', community_council: null, score: 100, match_type: 'PointAddress' },
      { address: '5 W 4th Ave', geocoded_date: '2026-11-10', matched_address: '5 W 4TH AVE', community_council: 'Downtown', score: 100, match_type: 'PointAddress' },
    ]);
    expect(await db.rows('SELECT cityview_license_id, geocoded_lng, community_council FROM licenses ORDER BY 1')).toEqual([
      { cityview_license_id: 1, geocoded_lng: null, community_council: null },
      { cityview_license_id: 2, geocoded_lng: null, community_council: null },
      { cityview_license_id: 3, geocoded_lng: -149.9, community_council: 'Downtown' },
      { cityview_license_id: 4, geocoded_lng: -151, community_council: null },
      { cityview_license_id: 5, geocoded_lng: -149.9, community_council: 'Downtown' },
      { cityview_license_id: 6, geocoded_lng: null, community_council: null },
    ]);
    // 1 of 5 geocodes failed; the match rate is a warning.
    expect(ok).toBe(true);
  });

  it('asks about a miss again after 90 days', async () => {
    const path = await freshPath();
    await scrape(path, '2026-11-10', fakeGis());
    const asked: string[] = [];
    await scrape(path, '2027-02-08', fakeGis(asked));

    const db = await opened(path);
    // 3 fails every time, so it is asked about every scrape.
    expect(asked.sort()).toEqual(['1 nowhere st', '2 street only', '3 boom ave']);
    expect(await db.value("SELECT geocoded_date FROM muni_address_geocodes WHERE address = '1 nowhere st'")).toBe('2027-02-08');
  });

  it('caps the addresses per scrape, Short-Term Rentals licenses first', async () => {
    const path = await freshPath();
    const asked: string[] = [];
    await scrapeLicenses({
      dbPath: path,
      scrapeDate: '2026-11-10',
      fetchNewest: async () => 6,
      fetchOne: async (id) => pages[id]!,
      gis: fakeGis(asked),
      maxGeocodes: 4,
    });

    expect(asked).not.toContain('5 W 4th Ave');
    expect(asked).toHaveLength(4);
  });

  it('keeps the page reads when it fails, and warns', async () => {
    const path = await freshPath();
    const ok = await scrape(path, '2026-11-10', {
      ...fakeGis(),
      fetchCouncils: async () => {
        throw new Error('ArcGIS is down');
      },
    });

    const db = await opened(path);
    expect(ok).toBe(true);
    expect(await db.count('SELECT count(*) FROM licenses')).toBe(6);
    expect(await db.count('SELECT count(*) FROM muni_address_geocodes')).toBe(0);
  });
});
