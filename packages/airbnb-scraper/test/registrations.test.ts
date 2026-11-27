/**
 * `listings_active_with_registration`: Airbnb listings written by the daily
 * run, joined to registrations from license page reads seeded directly. The
 * registration views themselves are tested in `packages/db`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import { muniLicensePageReads } from '@anchorage-str-db/db/schema';

import { recordObservations } from '../src/store.ts';
import { makeListing, page, pageMap } from './fixtures.ts';

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

describe('listings_active_with_registration', () => {
  it('joins listings to the registration their page cites', async () => {
    const db = await freshDb();
    await recordObservations(
      db,
      '2026-09-10',
      [makeListing(1, 'Echo Ridge'), makeListing(2, 'Echo Ridge loft'), makeListing(3, 'Unregistered')],
      pageMap([
        page('1', { registration: 'STR20260309' }),
        page('2', { registration: 'STR 20260309' }),
        page('3', { registration: 'STR20269999' }),
      ]),
    );
    await db.appendRows(muniLicensePageReads, [{ ...licensePage(13923), scrapeDate: '2026-09-10' }]);

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
