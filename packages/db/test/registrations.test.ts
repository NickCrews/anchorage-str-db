/**
 * The `licenses`, `registrations` and `latest_registry_date` views over
 * license page reads, hidden reads, scan runs and the archived registration
 * layer, seeded directly.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '../src/connect.ts';
import type { Database } from '../src/database.ts';
import {
  muniLicenseHiddenReads,
  muniLicensePageReads,
  muniLicenseRuns,
  muniStrRegistrationObservations,
  type LicenseIssuance,
} from '../src/schema.ts';

type PageRead = Omit<typeof muniLicensePageReads.$inferInsert, 'scrapeDate'>;
type ArchivedRegistration = Omit<typeof muniStrRegistrationObservations.$inferInsert, 'scrapeDate'>;

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDb(): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-registrations-'));
  temporary.push(dir);
  const db = await connect(join(dir, 't.duckdb'));
  open.push(db);
  return db;
}

function certificate(number: string, overrides: Partial<LicenseIssuance> = {}): LicenseIssuance {
  return {
    type: 'STR Certificate',
    issued_date: '2026-05-04',
    expires_date: '2027-04-30',
    status: 'Active',
    number,
    ...overrides,
  };
}

/** Echo Ridge Mountain Retreat, license 13923, as its page reads. */
function strPage(cityviewLicenseId: number, number: string, overrides: Partial<PageRead> = {}): PageRead {
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
        link: 'https://www.muni.org/CityViewPortal/Property/PropertyReview?searchKey=desc&searchValue=257',
      },
    ],
    issuances: [certificate(number)],
    submittals: [],
    ...overrides,
  };
}

/** A private detective license, which has no Locations section. */
function businessPage(cityviewLicenseId: number, status: string): PageRead {
  return {
    cityviewLicenseId,
    licenseId: 'LC261002840',
    businessName: 'Northern Investigations',
    licenseType: 'Business',
    status: 'Active',
    description: null,
    locations: [],
    issuances: [
      { type: 'Business License', issued_date: '2026-10-13', expires_date: null, status, number: 'PD 1400' },
    ],
    submittals: [],
  };
}

function archived(number: string, cityviewLicenseId: number, overrides: Partial<ArchivedRegistration> = {}): ArchivedRegistration {
  return {
    registrationId: number,
    licenseId: 'LC260500349',
    submittedDate: '2026-05-01',
    issuedDate: '2026-05-04',
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

async function readPages(db: Database, scrapeDate: string, pages: PageRead[]): Promise<void> {
  await db.appendRows(muniLicensePageReads, pages.map((p) => ({ ...p, scrapeDate })));
}

async function readHidden(db: Database, scrapeDate: string, ids: number[]): Promise<void> {
  await db.appendRows(muniLicenseHiddenReads, ids.map((cityviewLicenseId) => ({ cityviewLicenseId, scrapeDate })));
}

async function archive(db: Database, scrapeDate: string, rows: ArchivedRegistration[]): Promise<void> {
  await db.appendRows(muniStrRegistrationObservations, rows.map((r) => ({ ...r, scrapeDate })));
}

describe('licenses view', () => {
  it('holds every license type, with its latest read and read dates', async () => {
    const db = await freshDb();
    await readPages(db, '2026-11-01', [strPage(13923, 'STR20260309', { description: 'Short term rental' })]);
    await readPages(db, '2026-11-08', [strPage(13923, 'STR20260309'), businessPage(16427, 'Issued')]);

    const rows = await db.rows(
      'SELECT cityview_license_id, license_type, description, first_read_date, last_read_date, is_active ' +
        'FROM licenses ORDER BY 1',
    );

    expect(rows).toEqual([
      {
        cityview_license_id: 13923,
        license_type: 'Short-Term Rentals',
        description: 'Provides short term rentals, logistics, meeting space and overnight lodging.',
        first_read_date: '2026-11-01',
        last_read_date: '2026-11-08',
        is_active: true,
      },
      {
        cityview_license_id: 16427,
        license_type: 'Business',
        description: null,
        first_read_date: '2026-11-08',
        last_read_date: '2026-11-08',
        is_active: true,
      },
    ]);
  });

  it('leaves out a license whose latest read is hidden', async () => {
    const db = await freshDb();
    await readPages(db, '2026-11-01', [strPage(13923, 'STR20260309'), strPage(13924, 'STR20260310')]);
    await readHidden(db, '2026-11-08', [13923]);
    await readHidden(db, '2026-10-01', [13924]);

    const ids = await db.rows<{ cityview_license_id: number }>('SELECT cityview_license_id FROM licenses');

    expect(ids).toEqual([{ cityview_license_id: 13924 }]);
  });

  it("is active by the most recent issuance's status", async () => {
    const db = await freshDb();
    const issuance = (issued: string | null, status: string): LicenseIssuance => ({
      type: 'Marijuana Establishment',
      issued_date: issued,
      expires_date: null,
      status,
      number: 'M10021',
    });
    await readPages(db, '2026-11-08', [
      // Newest first, as the page lists them.
      { ...businessPage(13270, 'Issued'), issuances: [issuance('2026-10-08', 'Issued'), issuance('2024-03-20', 'Expired')] },
      { ...businessPage(13400, 'Expired'), issuances: [issuance('2023-08-16', 'Expired')] },
      { ...businessPage(9480, 'Pending'), issuances: [issuance(null, 'Pending')] },
      { ...businessPage(559, 'Active'), licenseType: 'Alcohol', issuances: [issuance(null, 'Active')] },
      { ...businessPage(1, 'Active'), issuances: [] },
    ]);

    const rows = await db.rows('SELECT cityview_license_id, is_active FROM licenses ORDER BY 1');

    expect(rows).toEqual([
      { cityview_license_id: 1, is_active: false },
      { cityview_license_id: 559, is_active: true },
      { cityview_license_id: 9480, is_active: false },
      { cityview_license_id: 13270, is_active: true },
      { cityview_license_id: 13400, is_active: false },
    ]);
  });
});

describe('registrations view', () => {
  it('has one row per STR Certificate number, on Short-Term Rentals licenses only', async () => {
    const db = await freshDb();
    await readPages(db, '2026-11-01', [strPage(13923, 'STR20260309'), strPage(13924, 'STR20260310')]);
    await readPages(db, '2026-11-08', [
      strPage(13923, 'STR20260309'),
      businessPage(16427, 'Issued'),
      { ...businessPage(559, 'Active'), licenseType: 'Alcohol' },
    ]);

    const rows = await db.rows(
      'SELECT registration_id, cityview_license_id, status_url, license_read_date, first_seen_date, ' +
        'last_seen_date, is_active FROM registrations ORDER BY 1',
    );

    expect(rows).toEqual([
      {
        registration_id: 'STR20260309',
        cityview_license_id: 13923,
        status_url: 'https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B',
        license_read_date: '2026-11-08',
        first_seen_date: '2026-11-01',
        last_seen_date: '2026-11-08',
        is_active: true,
      },
      {
        registration_id: 'STR20260310',
        cityview_license_id: 13924,
        status_url: 'https://www.muni.org/CityViewPortal/License/Status?licenseId=13924&category=B',
        license_read_date: '2026-11-01',
        first_seen_date: '2026-11-01',
        last_seen_date: '2026-11-01',
        is_active: true,
      },
    ]);
  });

  it('is active when the STR Certificate is Active', async () => {
    const db = await freshDb();
    await readPages(db, '2026-11-08', [
      strPage(13923, 'STR20260309'),
      strPage(13924, 'STR20260310', { issuances: [certificate('STR20260310', { status: 'Expired' })] }),
    ]);

    const rows = await db.rows('SELECT registration_id, status, is_active FROM registrations ORDER BY 1');

    expect(rows).toEqual([
      { registration_id: 'STR20260309', status: 'Active', is_active: true },
      { registration_id: 'STR20260310', status: 'Expired', is_active: false },
    ]);
  });

  it('takes the layer fields from the archive, and NULL for a registration it never held', async () => {
    const db = await freshDb();
    await archive(db, '2026-09-10', [archived('STR20260309', 13923, { communityCouncil: 'Turnagain Arm' })]);
    await archive(db, '2026-09-11', [archived('STR20260309', 13923)]);
    await readPages(db, '2026-11-08', [strPage(13923, 'STR20260309'), strPage(16455, 'STR20262796')]);

    const rows = await db.rows(
      'SELECT registration_id, submitted_date, community_council, parcel_type, geocoded_lat, ' +
        'first_seen_date FROM registrations ORDER BY 1',
    );

    expect(rows).toEqual([
      {
        registration_id: 'STR20260309',
        submitted_date: '2026-05-01',
        community_council: 'Girdwood',
        parcel_type: 'Residential',
        geocoded_lat: 60.96,
        first_seen_date: '2026-11-08',
      },
      {
        registration_id: 'STR20262796',
        submitted_date: null,
        community_council: null,
        parcel_type: null,
        geocoded_lat: null,
        first_seen_date: '2026-11-08',
      },
    ]);
  });

  it('keeps a registration only the archive holds, as not active', async () => {
    const db = await freshDb();
    await archive(db, '2026-09-10', [archived('STR20260001', 13610)]);
    await archive(db, '2026-09-11', [archived('STR20260001', 13610)]);

    const [row] = await db.rows(
      'SELECT registration_id, cityview_license_id, status, business_name, registered_address, ' +
        'community_council, license_read_date, license_parcel_ids, first_seen_date, last_seen_date, is_active ' +
        'FROM registrations',
    );

    expect(row).toEqual({
      registration_id: 'STR20260001',
      cityview_license_id: 13610,
      status: 'Active',
      business_name: 'Echo Ridge Mountain Retreat',
      registered_address: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587',
      community_council: 'Girdwood',
      license_read_date: null,
      license_parcel_ids: null,
      first_seen_date: '2026-09-10',
      last_seen_date: '2026-09-11',
      is_active: false,
    });
  });

  it("cleans the 'None' business name and the no-match placeholder coordinate", async () => {
    const db = await freshDb();
    await archive(db, '2026-09-10', [
      archived('STR20260126', 13700, {
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

  it('takes the registered address from the Address location, else the typed text', async () => {
    const db = await freshDb();
    await readPages(db, '2026-11-08', [
      strPage(13923, 'STR20260309'),
      strPage(13924, 'STR20260310', {
        locations: [{ label: null, value: '525 w 3rd Ave #501, anchorage AK 99501', link: null }],
      }),
    ]);

    const rows = await db.rows('SELECT registration_id, registered_address FROM registrations ORDER BY 1');

    expect(rows).toEqual([
      { registration_id: 'STR20260309', registered_address: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587' },
      { registration_id: 'STR20260310', registered_address: '525 w 3rd Ave #501, anchorage AK 99501' },
    ]);
  });

  it('leaves parcel_id NULL when a license lists several parcels', async () => {
    const db = await freshDb();
    await readPages(db, '2026-11-08', [
      strPage(13923, 'STR20260309', {
        locations: [
          { label: 'Property', value: '07606227000', link: null },
          { label: 'Property', value: '07606228000', link: null },
        ],
      }),
    ]);

    const [row] = await db.rows('SELECT parcel_id, license_parcel_ids FROM registrations');

    expect(row).toEqual({ parcel_id: null, license_parcel_ids: ['07606227000', '07606228000'] });
  });

  it('drops a registration whose license is hidden at its latest read, unless the archive holds it', async () => {
    const db = await freshDb();
    await archive(db, '2026-09-11', [archived('STR20260309', 13923)]);
    await readPages(db, '2026-11-01', [strPage(13923, 'STR20260309'), strPage(13924, 'STR20260310')]);
    await readHidden(db, '2026-11-08', [13923, 13924]);

    const rows = await db.rows('SELECT registration_id, license_read_date, is_active FROM registrations');

    expect(rows).toEqual([{ registration_id: 'STR20260309', license_read_date: null, is_active: false }]);
  });
});

describe('latest_registry_date', () => {
  it('is the latest license scan that completed its writes', async () => {
    const db = await freshDb();
    const run = (scrapeDate: string, errorSummary: string | null) => ({
      scrapeDate,
      runStartedAt: `${scrapeDate} 08:00:00`,
      runFinishedAt: `${scrapeDate} 08:25:00`,
      pagesAttempted: errorSummary ? null : 10,
      errorSummary,
    });
    await db.orm.insert(muniLicenseRuns).values([run('2026-11-07', null), run('2026-11-08', 'portal down')]);

    expect(await db.value('SELECT scrape_date FROM latest_registry_date')).toBe('2026-11-07');
  });
});
