/**
 * The join views, which are what "integrate this into the existing database"
 * comes down to: both sides in one file, matched on the registration number.
 *
 * The scraper's tables are not imported here. These tests stand up a
 * `listings_current` with the columns the views read, which is also a check
 * that the views depend on no more of the scraper's schema than that.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Database } from '../src/db.ts';
import { normalizeRegistrationId } from '../src/fields.ts';
import type { RegistrationRecord } from '../src/records.ts';
import { connect, mergeRegistrations } from '../src/store.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The columns of `listings_current` that the join views read. */
const LISTINGS_COLUMNS =
  'listing_id BIGINT, name VARCHAR, host_id BIGINT, room_type VARCHAR, ' +
  'location_lat DOUBLE, location_lng DOUBLE, location_is_exact BOOLEAN, ' +
  'str_registration_id VARCHAR';

async function dbWithListings(
  listings: ReadonlyArray<{ id: number; registration: string | null }>,
): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-registry-join-'));
  temporary.push(dir);
  const path = join(dir, 't.duckdb');

  // Stand in for the scraper's output, created before `connect` so the join
  // views have something to bind to.
  const seed = await Database.open(path);
  await seed.run(`CREATE TABLE listings_current (${LISTINGS_COLUMNS})`);
  for (const listing of listings) {
    await seed.run(
      'INSERT INTO listings_current VALUES (?, ?, 1, \'Entire home/apt\', 61.0, -149.0, true, ?)',
      [BigInt(listing.id), `Listing ${listing.id}`, listing.registration],
    );
  }
  seed.close();

  const db = await connect(path);
  open.push(db);
  return db;
}

function record(label: string): RegistrationRecord {
  const registrationId = normalizeRegistrationId(label);
  return {
    recordKey: registrationId ?? label,
    registrationId,
    registrationLabel: label,
    objectId: 1,
    status: 'Active',
    registrationType: 'Whole home',
    address: '123 Alyeska Hwy',
    unit: null,
    zip: '99587',
    parcelId: '075-123-45-000',
    operatorName: 'A Host',
    issuedDate: '2026-05-12',
    expiresDate: '2027-05-12',
    editedDate: null,
    locationLat: 60.965,
    locationLng: -149.123,
    attributes: { STR_Number: label },
    attrsHash: label,
  };
}

async function coverage(db: Database): Promise<Record<string, number>> {
  const rows = await db.rows<{ match_kind: string; listings: number; registrations: number }>(
    'SELECT * FROM listing_registration_coverage ORDER BY match_kind',
  );
  return Object.fromEntries(rows.map((row) => [row.match_kind, Number(row.listings)]));
}

describe('the join views', () => {
  it('are not created in a database with no listings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchorage-registry-solo-'));
    temporary.push(dir);
    const db = await connect(join(dir, 't.duckdb'));
    open.push(db);
    expect(
      await db.count(
        "SELECT count(*) FROM duckdb_views() WHERE view_name = 'listing_registration_matches'",
      ),
    ).toBe(0);
  });

  it('matches a listing to its registration through both sides being normalized', async () => {
    // The host typed the number with its own spacing; the Municipality
    // publishes it with dashes. Neither side is edited, and they still meet.
    const db = await dbWithListings([{ id: 1, registration: 'str 2026 0001' }]);
    await mergeRegistrations(db, '2026-09-01', [record('STR-2026-0001')]);

    expect(
      await db.rows(
        'SELECT listing_id, registration_id, registration_status, match_kind ' +
          'FROM listing_registration_matches',
      ),
    ).toEqual([
      {
        listing_id: '1',
        registration_id: 'STR20260001',
        registration_status: 'Active',
        match_kind: 'matched',
      },
    ]);
  });

  it('tells apart the three ways a listing can fail to match', async () => {
    const db = await dbWithListings([
      { id: 1, registration: 'STR-2026-0001' }, // matches
      { id: 2, registration: null }, // shows no number at all
      { id: 3, registration: 'pending' }, // shows something that is not one
      { id: 4, registration: 'STR-2026-9999' }, // shows a number not in the registry
    ]);
    await mergeRegistrations(db, '2026-09-01', [record('STR-2026-0001'), record('STR-2026-0002')]);

    expect(await coverage(db)).toEqual({
      matched: 1,
      listing_unregistered: 2,
      listing_number_unmatched: 1,
      // A registration nobody advertises on Airbnb: STR-2026-0002.
      registration_only: 0,
    });
    expect(
      await db.count(
        "SELECT count(*) FROM listing_registration_matches WHERE match_kind = 'registration_only'",
      ),
    ).toBe(1);
  });

  it('keeps a many-to-many match rather than picking one side', async () => {
    // One registration covering two rooms is a real arrangement, not a bug
    // to deduplicate away.
    const db = await dbWithListings([
      { id: 1, registration: 'STR-2026-0001' },
      { id: 2, registration: 'STR-2026-0001' },
    ]);
    await mergeRegistrations(db, '2026-09-01', [record('STR-2026-0001')]);
    expect(await coverage(db)).toEqual({ matched: 2 });
  });

  it('drops a registration from the current view once it leaves the layer', async () => {
    const db = await dbWithListings([{ id: 1, registration: 'STR-2026-0001' }]);
    await mergeRegistrations(db, '2026-09-01', [record('STR-2026-0001')]);
    expect(await coverage(db)).toEqual({ matched: 1 });

    await mergeRegistrations(db, '2026-09-02', []);
    // The listing still advertises a number the registry no longer holds,
    // which is the enforcement question, so it must not read as unregistered.
    expect(await coverage(db)).toEqual({ listing_number_unmatched: 1 });
    expect(
      await db.rows("SELECT removed_date FROM str_registrations WHERE record_key = 'STR20260001'"),
    ).toEqual([{ removed_date: '2026-09-02' }]);
  });
});
