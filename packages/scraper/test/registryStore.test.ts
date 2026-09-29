import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import type { LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import { emptyListingPage } from '@anchorage-str-db/scraper-airbnb/listingPage';
import type { Registration } from '@anchorage-str-db/scraper-muni-str/registrationLayers';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import {
  chooseLicensePages,
  logRegistryRun,
  pendingLicensePages,
  recordLicensePages,
  recordRegistrations,
} from '../src/registryStore.ts';
import { recordObservations } from '../src/store.ts';
import { makeListing } from './fixtures.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDb(): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-registry-'));
  temporary.push(dir);
  const db = await connect(join(dir, 't.duckdb'));
  open.push(db);
  return db;
}

function registration(number: string, cityviewLicenseId: number, overrides: Partial<Registration> = {}): Registration {
  return {
    registrationId: number,
    licenseId: `LC${number.slice(3)}0`,
    submittedDate: '2026-05-01',
    issuedDate: '2026-05-01',
    expiresDate: '2027-04-30',
    registeredAddress: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587',
    businessName: 'Echo Ridge Mountain Retreat',
    status: 'Active',
    statusUrl: `https://www.muni.org/CityViewPortal/License/Status?licenseId=${cityviewLicenseId}&category=B`,
    communityCouncil: 'Girdwood',
    parcelType: 'Residential',
    geocodedAddress: '257 Echo Ridge Dr, Girdwood, Alaska, 99587',
    geocodedLat: 60.96,
    geocodedLng: -149.11,
    publishedAt: '2026-09-07 00:00:00',
    ...overrides,
  };
}

function licensePage(cityviewLicenseId: number, overrides: Partial<LicensePage> = {}): LicensePage {
  return {
    cityviewLicenseId,
    licenseId: 'LC260500349',
    businessName: 'Echo Ridge Mountain Retreat',
    licenseType: 'Short-Term Rentals',
    status: 'Active',
    description: 'Provides short term rentals, logistics, meeting space and overnight lodging.',
    locations: [
      {
        label: 'Property',
        value: '07606227000',
        link: 'https://www.muni.org/CityViewPortal/Property/PropertyReview?searchKey=desc&searchValue=07606227000',
      },
      {
        label: 'Address',
        value: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587',
        link: 'https://www.muni.org/CityViewPortal/Property/PropertyReview?searchKey=desc&searchValue=257%20ECHO%20RIDGE%20DR%2C%20GIRDWOOD%2C%20AK%2099587',
      },
    ],
    issuances: [
      {
        type: 'STR Certificate',
        issuedDate: '2026-05-04',
        expiresDate: '2027-04-30',
        status: 'Active',
        number: 'STR20260309',
      },
    ],
    ...overrides,
  };
}

/** Record a registry run the way `runRegistry` does, minus the network. */
async function registryRun(
  db: Database,
  scrapeDate: IsoDate,
  registrations: Registration[],
  pages: LicensePage[] = [],
) {
  const stats = await recordRegistrations(db, scrapeDate, registrations);
  await recordLicensePages(db, scrapeDate, pages);
  await logRegistryRun(db, {
    scrapeDate,
    runStartedAt: `${scrapeDate} 00:00:00`,
    runFinishedAt: `${scrapeDate} 00:10:00`,
    layerDataEditedAt: '2026-09-07 00:15:52',
    registrationsSeen: stats.seen,
    registrationsNew: stats.new,
    registrationsLapsed: stats.lapsed,
    licensePageAttempted: pages.length,
    licensePageFailed: 0,
    errorSummary: null,
  });
  return stats;
}

describe('recordRegistrations', () => {
  it('counts new registrations and those gone since the previous run', async () => {
    const db = await freshDb();
    const first = await registryRun(db, '2026-09-10', [
      registration('STR20260001', 1),
      registration('STR20260002', 2),
    ]);
    const second = await registryRun(db, '2026-09-11', [
      registration('STR20260002', 2),
      registration('STR20260003', 3),
    ]);

    expect(first).toEqual({ seen: 2, new: 2, lapsed: 0 });
    expect(second).toEqual({ seen: 2, new: 1, lapsed: 1 });
  });

  it('replaces a day that is recorded again, not counting its own earlier rows', async () => {
    const db = await freshDb();
    await registryRun(db, '2026-09-10', [registration('STR20260001', 1)]);
    const again = await recordRegistrations(db, '2026-09-10', [registration('STR20260001', 1)]);

    expect(again).toEqual({ seen: 1, new: 1, lapsed: 0 });
    expect(await db.count('SELECT count(*) FROM muni_str_registration_observations')).toBe(1);
  });

  it('rejects a layer that repeats a registration id', async () => {
    const db = await freshDb();

    await expect(
      recordRegistrations(db, '2026-09-10', [registration('STR20260001', 1), registration('STR20260001', 1)]),
    ).rejects.toThrow(/repeats 1 registration ids/);
  });
});

describe('registrations view', () => {
  it('marks registrations missing from the latest run as not current', async () => {
    const db = await freshDb();
    await registryRun(db, '2026-09-10', [registration('STR20260001', 1), registration('STR20260002', 2)]);
    await registryRun(db, '2026-09-11', [registration('STR20260002', 2)]);

    const rows = await db.rows<{ registration_id: string; is_active: boolean; last_seen_date: string }>(
      'SELECT registration_id, is_active, last_seen_date FROM registrations ORDER BY 1',
    );

    expect(rows).toEqual([
      { registration_id: 'STR20260001', is_active: false, last_seen_date: '2026-09-10' },
      { registration_id: 'STR20260002', is_active: true, last_seen_date: '2026-09-11' },
    ]);
  });

  it("cleans the 'None' business name and the no-match placeholder coordinate", async () => {
    const db = await freshDb();
    await registryRun(db, '2026-09-10', [
      registration('STR20260126', 1, {
        businessName: 'None',
        geocodedAddress: 'Incomplete address provided. No Match.',
        geocodedLat: 61.153442,
        geocodedLng: -150.20935,
      }),
    ]);

    const [row] = await db.rows('SELECT business_name, geocoded_lat, geocoded_lng FROM registrations');
    const [raw] = await db.rows('SELECT business_name, geocoded_lat FROM muni_str_registration_observations');

    expect(row).toEqual({ business_name: null, geocoded_lat: null, geocoded_lng: null });
    expect(raw).toEqual({ business_name: 'None', geocoded_lat: 61.153442 });
  });

  it("takes the license's parcel id, description and latest read", async () => {
    const db = await freshDb();
    await registryRun(db, '2026-09-10', [registration('STR20260309', 13923)], [
      licensePage(13923, { description: 'Short term rental' }),
    ]);
    await registryRun(db, '2026-09-11', [registration('STR20260309', 13923)], [licensePage(13923)]);

    const [row] = await db.rows(
      'SELECT cityview_license_id, license_read_date, license_description, parcel_id, ' +
        'license_parcel_ids, license_addresses FROM registrations',
    );

    expect(row).toEqual({
      cityview_license_id: 13923,
      license_read_date: '2026-09-11',
      license_description: 'Provides short term rentals, logistics, meeting space and overnight lodging.',
      parcel_id: '07606227000',
      license_parcel_ids: ['07606227000'],
      license_addresses: ['257 ECHO RIDGE DR, GIRDWOOD, AK 99587'],
    });
  });

  it('leaves parcel_id NULL when a license lists several parcels', async () => {
    const db = await freshDb();
    await registryRun(db, '2026-09-10', [registration('STR20260309', 13923)], [
      licensePage(13923, {
        locations: [
          { label: 'Property', value: '07606227000', link: null },
          { label: 'Property', value: '07606228000', link: null },
        ],
      }),
    ]);

    const [row] = await db.rows('SELECT parcel_id, license_parcel_ids FROM registrations');

    expect(row).toEqual({ parcel_id: null, license_parcel_ids: ['07606227000', '07606228000'] });
  });
});

describe('listings_active_with_registration', () => {
  it('joins listings to the registration their page cites', async () => {
    const db = await freshDb();
    await recordObservations(
      db,
      '2026-09-10',
      [makeListing(1, 'Echo Ridge'), makeListing(2, 'Echo Ridge loft'), makeListing(3, 'Unregistered')],
      [
        { ...emptyListingPage('1'), registrationId: 'STR20260309' },
        { ...emptyListingPage('2'), registrationId: 'STR20260309' },
        { ...emptyListingPage('3'), registrationId: 'STR20269999' },
      ],
    );
    await registryRun(db, '2026-09-10', [registration('STR20260309', 13923)], [licensePage(13923)]);

    const rows = await db.rows(
      'SELECT listing_id, registration_found, registration_parcel_id, ' +
        'registration_airbnb_listings_active FROM listings_active_with_registration ORDER BY 1',
    );

    expect(rows).toEqual([
      {
        listing_id: '1',
        registration_found: true,
        registration_parcel_id: '07606227000',
        registration_airbnb_listings_active: 2,
      },
      {
        listing_id: '2',
        registration_found: true,
        registration_parcel_id: '07606227000',
        registration_airbnb_listings_active: 2,
      },
      {
        listing_id: '3',
        registration_found: false,
        registration_parcel_id: null,
        registration_airbnb_listings_active: null,
      },
    ]);
  });
});

describe('recordLicensePages', () => {
  it('keeps pages read earlier the same day and replaces a page read again', async () => {
    const db = await freshDb();
    await recordLicensePages(db, '2026-09-10', [licensePage(1), licensePage(2, { status: 'Active' })]);
    await recordLicensePages(db, '2026-09-10', [licensePage(2, { status: 'Revoked' })]);

    const rows = await db.rows('SELECT cityview_license_id, status FROM muni_license_page_reads ORDER BY 1');

    expect(rows).toEqual([
      { cityview_license_id: 1, status: 'Active' },
      { cityview_license_id: 2, status: 'Revoked' },
    ]);
  });

  it('stores issuance dates as dates and a license with no locations as an empty list', async () => {
    const db = await freshDb();
    await recordLicensePages(db, '2026-09-10', [licensePage(1, { locations: [] })]);

    const [row] = await db.rows<{ locations: unknown[]; issued: string }>(
      'SELECT locations, issuances[1].issued_date AS issued FROM muni_license_page_reads',
    );

    expect(row).toEqual({ locations: [], issued: '2026-05-04' });
  });
});

describe('chooseLicensePages', () => {
  const base = {
    scrapeDate: '2026-09-20',
    refreshDays: 7,
    max: 100,
  };

  it('reads unread licenses, then lapsed ones, then stale ones oldest first', () => {
    const chosen = chooseLicensePages({
      ...base,
      today: new Set([10, 11, 12, 13, 14]),
      lastRead: new Map([
        [11, '2026-09-19'], // fresh
        [12, '2026-09-13'], // exactly refreshDays old
        [13, '2026-09-01'], // stalest
        [20, '2026-09-01'], // lapsed, read before it left
        [21, '2026-09-18'], // lapsed, already read after it left
      ]),
      lastSeen: new Map([
        [10, '2026-09-19'],
        [20, '2026-09-15'],
        [21, '2026-09-15'],
        [22, '2026-09-15'], // lapsed, never read
      ]),
    });

    expect(chosen).toEqual([10, 14, 20, 22, 13, 12]);
  });

  it('stops at max', () => {
    const chosen = chooseLicensePages({
      ...base,
      max: 2,
      today: new Set([3, 1, 2]),
      lastRead: new Map(),
      lastSeen: new Map(),
    });

    expect(chosen).toEqual([1, 2]);
  });
});

describe('pendingLicensePages', () => {
  it("reads history from the database and ignores a re-run's own day", async () => {
    const db = await freshDb();
    await registryRun(db, '2026-09-10', [registration('STR20260001', 1), registration('STR20260002', 2)], [
      licensePage(1),
    ]);
    // Today's rows exist from an earlier run the same day.
    await registryRun(db, '2026-09-11', [registration('STR20260001', 1)]);

    const pending = await pendingLicensePages(db, '2026-09-11', [registration('STR20260001', 1)], {
      refreshDays: 7,
      max: 100,
    });

    // 2 left the layer and was never read; 1 was read yesterday.
    expect(pending).toEqual([2]);
  });

  it('re-reads a license whose latest read is refreshDays old', async () => {
    const db = await freshDb();
    await registryRun(db, '2026-09-01', [registration('STR20260001', 1)], [licensePage(1)]);

    const pending = await pendingLicensePages(db, '2026-09-08', [registration('STR20260001', 1)], {
      refreshDays: 7,
      max: 100,
    });

    expect(pending).toEqual([1]);
  });
});
