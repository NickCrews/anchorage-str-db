/**
 * The registration views over the archived registration layer rows and the
 * license page reads, seeded directly: no run writes the layer's tables.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import {
  muniLicensePageReads,
  muniStrRegistrationObservations,
  muniStrRegistryRuns,
} from '@anchorage-str-db/db/schema';
import { emptyListingPage } from '@anchorage-str-db/scraper-airbnb/listingPage';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import { recordObservations } from '../src/store.ts';
import { makeListing } from './fixtures.ts';

type Registration = Omit<typeof muniStrRegistrationObservations.$inferInsert, 'scrapeDate'>;
type PageRead = Omit<typeof muniLicensePageReads.$inferInsert, 'scrapeDate'>;

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

function licensePage(cityviewLicenseId: number, overrides: Partial<PageRead> = {}): PageRead {
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
        issued_date: '2026-05-04',
        expires_date: '2027-04-30',
        status: 'Active',
        number: 'STR20260309',
      },
    ],
    submittals: [],
    ...overrides,
  };
}

/** A registry run's rows in the archived layer tables, and its page reads. */
async function registryRun(
  db: Database,
  scrapeDate: IsoDate,
  registrations: Registration[],
  pages: PageRead[] = [],
): Promise<void> {
  await db.appendRows(
    muniStrRegistrationObservations,
    registrations.map((r) => ({ ...r, scrapeDate })),
  );
  if (pages.length) await db.appendRows(muniLicensePageReads, pages.map((p) => ({ ...p, scrapeDate })));
  await db.orm.insert(muniStrRegistryRuns).values({
    scrapeDate,
    runStartedAt: `${scrapeDate} 00:00:00`,
    runFinishedAt: `${scrapeDate} 00:10:00`,
    registrationsSeen: registrations.length,
  });
}

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
