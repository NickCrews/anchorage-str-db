import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CalendarNight, CalendarResult } from '../src/calendars.ts';
import { addDays, type IsoDate } from '../src/dates.ts';
import type { Database } from '../src/db.ts';
import { emptyListingPage, type ListingPage } from '../src/listingPage.ts';
import {
  connect,
  LegacySchemaError,
  logRun,
  mergeCalendar,
  recordObservations,
  type RunRow,
} from '../src/store.ts';
import { makeListing } from './fixtures.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A fresh on-disk database, so tests can reopen it to verify commits. */
async function freshDb(name = 't.duckdb'): Promise<{ db: Database; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-'));
  temporary.push(dir);
  const path = join(dir, name);
  const db = await connect(path);
  open.push(db);
  return { db, path };
}

function page(roomId: string, fields: Partial<ListingPage> = {}): ListingPage {
  return { ...emptyListingPage(roomId), ...fields };
}

function runRow(scrapeDate: IsoDate, overrides: Partial<RunRow> = {}): RunRow {
  return {
    scrapeDate,
    runStartedAt: `${scrapeDate} 00:00:00`,
    runFinishedAt: `${scrapeDate} 00:00:00`,
    listingsSeen: 1,
    listingsNew: 0,
    listingsChanged: 0,
    listingsRetired: 0,
    calendarFetchAttempted: 0,
    calendarFetchFailed: 0,
    calendarNightsChanged: 0,
    pageFetchAttempted: null,
    pageFetchFailed: null,
    errorSummary: null,
    ...overrides,
  };
}

function night(
  nightDate: IsoDate,
  available: boolean,
  minNights: number | null,
  priceAmount: number | null,
): CalendarNight {
  return { nightDate, available, minNights, priceAmount };
}

function calendar(roomId: string, nights: CalendarNight[], error: string | null = null): CalendarResult {
  return { roomId, nights, error };
}

// --------------------------------------------------------------------------
// listings

describe('recordObservations', () => {
  it('counts new and unchanged listings', async () => {
    const { db } = await freshDb();
    const dayOne = [makeListing(1, 'Cabin A'), makeListing(2, 'Cabin B')];

    expect(await recordObservations(db, '2026-08-01', dayOne)).toEqual({
      seen: 2,
      new: 2,
      changed: 2,
      retired: 0,
    });

    // Same attributes the next day: new rows, no new versions.
    const second = await recordObservations(db, '2026-08-02', dayOne);
    expect(second.new).toBe(0);
    expect(second.changed).toBe(0);
    expect(await db.count('SELECT count(*) FROM listing_observations')).toBe(4);
    expect(await db.count('SELECT count(*) FROM listings WHERE is_current')).toBe(2);
  });

  it('detects an attribute change', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-01', [makeListing(1, 'Cabin A')]);
    const stats = await recordObservations(db, '2026-08-02', [makeListing(1, 'Cabin A Renamed')]);

    expect(stats.changed).toBe(1);
    expect(stats.new).toBe(0);
    expect(
      await db.rows(
        'SELECT name, valid_from, valid_to, is_current FROM listings ' +
          'WHERE listing_id = 1 ORDER BY valid_from',
      ),
    ).toEqual([
      { name: 'Cabin A', valid_from: '2026-08-01', valid_to: '2026-08-02', is_current: false },
      { name: 'Cabin A Renamed', valid_from: '2026-08-02', valid_to: null, is_current: true },
    ]);
  });

  it('does not open a new version for a new review', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-01', [makeListing(1, 'Cabin A')]);

    const busier = { ...makeListing(1, 'Cabin A'), reviewCount: 99, ratingValue: 4.5, priceHintPerNight: 999 };
    const stats = await recordObservations(db, '2026-08-02', [busier]);

    expect(stats.changed).toBe(0);
    expect(await db.count('SELECT count(*) FROM listings')).toBe(1);
    // The day's values are still recorded.
    expect(
      await db.rows('SELECT review_count FROM listing_observations ORDER BY scrape_date'),
    ).toEqual([{ review_count: 10 }, { review_count: 99 }]);
  });

  it('is idempotent per day', async () => {
    const { db } = await freshDb();
    const listings = [makeListing(1, 'A'), makeListing(2, 'B')];
    const first = await recordObservations(db, '2026-08-01', listings);
    const again = await recordObservations(db, '2026-08-01', listings);

    expect(await db.count('SELECT count(*) FROM listing_observations')).toBe(2);
    // Including new=2 on the re-run.
    expect(again).toEqual(first);
  });
});

describe('retirement', () => {
  it('has a grace period', async () => {
    const { db } = await freshDb();
    const start = '2026-08-01';
    const grace = 5;

    for (let i = 0; i < 3; i++) {
      await recordObservations(db, addDays(start, i), [makeListing(1, 'A'), makeListing(2, 'B')]);
    }

    // Listing 2 stops appearing from day 3 onward.
    let retiredOn: IsoDate | null = null;
    for (let i = 3; i < 3 + grace + 3; i++) {
      const day = addDays(start, i);
      const stats = await recordObservations(db, day, [makeListing(1, 'A')]);
      if (stats.retired && retiredOn === null) retiredOn = day;
    }

    // Last seen on start + 2, so retired grace + 1 days later.
    expect(retiredOn).toBe(addDays(start, 2 + grace + 1));
    expect(await db.rows('SELECT listing_id, is_current FROM listings ORDER BY listing_id')).toEqual(
      [
        { listing_id: '1', is_current: true },
        { listing_id: '2', is_current: false },
      ],
    );
  });

  it('advances the clock even on a run that sees nothing', async () => {
    const { db } = await freshDb();
    const start = '2026-08-01';
    await recordObservations(db, start, [makeListing(1, 'A')]);
    await logRun(db, runRow(start));

    for (let i = 1; i < 10; i++) {
      const day = addDays(start, i);
      await recordObservations(db, day, []);
      await logRun(db, runRow(day, { listingsSeen: 0 }));
    }

    expect(await db.count('SELECT count(*) FROM listings WHERE is_current')).toBe(0);
  });

  it('is not advanced by a failed run', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-01', [makeListing(1, 'A')]);
    await logRun(
      db,
      runRow('2026-12-01', {
        listingsSeen: null,
        listingsNew: null,
        listingsChanged: null,
        listingsRetired: null,
        errorSummary: 'HttpError: HTTP 403',
      }),
    );

    expect(await db.count('SELECT count(*) FROM listings WHERE is_current')).toBe(1);
  });

  it('keeps a listing’s history when it comes back', async () => {
    const { db } = await freshDb();
    const read = page('1', { locationIsExact: true, strRegistrationId: 'STR20260001' });
    await recordObservations(db, '2026-08-01', [makeListing(1, 'Cabin A')], [read]);

    for (let i = 2; i < 12; i++) {
      // gone long enough to be retired
      const day = `2026-08-${String(i).padStart(2, '0')}`;
      await recordObservations(db, day, []);
      await logRun(db, runRow(day, { listingsSeen: 0 }));
    }
    expect(await db.count('SELECT count(*) FROM listings WHERE is_current')).toBe(0);

    await recordObservations(db, '2026-08-20', [makeListing(1, 'Cabin A')], [read]);

    expect(
      await db.rows(
        'SELECT first_seen_date, last_seen_date, str_registration_id, is_current ' +
          'FROM listings WHERE listing_id = 1',
      ),
    ).toEqual([
      {
        first_seen_date: '2026-08-01',
        last_seen_date: '2026-08-20',
        str_registration_id: 'STR20260001',
        is_current: true,
      },
    ]);
  });
});

// --------------------------------------------------------------------------
// listing-page fields

describe('listing-page fields', () => {
  it('land on the listing row', async () => {
    const { db } = await freshDb();
    await recordObservations(
      db,
      '2026-08-26',
      [makeListing(1, 'Cabin A'), makeListing(2, 'Cabin B')],
      [
        page('1', {
          locationIsExact: true,
          strRegistrationId: 'STR20260001',
          locationSource: 'json-ld+state',
        }),
        page('2', { locationIsExact: false, locationSource: 'json-ld+state' }),
      ],
    );

    expect(
      await db.rows(
        'SELECT listing_id, location_is_exact, str_registration_id, page_seen_date ' +
          'FROM listings WHERE is_current ORDER BY listing_id',
      ),
    ).toEqual([
      {
        listing_id: '1',
        location_is_exact: true,
        str_registration_id: 'STR20260001',
        page_seen_date: '2026-08-26',
      },
      {
        listing_id: '2',
        location_is_exact: false,
        str_registration_id: null,
        page_seen_date: '2026-08-26',
      },
    ]);
  });

  it('carry forward rather than blanking on a run without pages', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [
      page('1', { locationIsExact: true, strRegistrationId: 'STR20260001' }),
    ]);

    const stats = await recordObservations(db, '2026-08-27', parsed);

    expect(stats.changed).toBe(0);
    expect(await db.count('SELECT count(*) FROM listings')).toBe(1);
    expect(
      await db.rows(
        'SELECT location_is_exact, str_registration_id FROM listings WHERE is_current',
      ),
    ).toEqual([{ location_is_exact: true, str_registration_id: 'STR20260001' }]);
  });

  it('carry forward past a failed page fetch too', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { locationIsExact: true })]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { error: 'HttpError: HTTP 429' }),
    ]);

    expect(stats.changed).toBe(0);
    expect(await db.rows('SELECT location_is_exact FROM listings WHERE is_current')).toEqual([
      { location_is_exact: true },
    ]);
    // The raw row records the failure; only the view carries values forward.
    expect(
      await db.rows(
        "SELECT page_fetch_ok, location_is_exact FROM listing_observations " +
          "WHERE scrape_date = '2026-08-27'",
      ),
    ).toEqual([{ page_fetch_ok: false, location_is_exact: null }]);
  });

  it('do not resurrect a removed registration number after a later failure', async () => {
    // A failed fetch carries forward the last read ("no number"), not the
    // last non-null number.
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [
      page('1', { locationIsExact: true, strRegistrationId: 'STR20260001' }),
    ]);
    // Read the page; the host has taken the number down.
    await recordObservations(db, '2026-08-27', parsed, [page('1', { locationIsExact: true })]);
    // Now a failed fetch.
    await recordObservations(db, '2026-08-28', parsed, [
      page('1', { error: 'HttpError: HTTP 429' }),
    ]);

    expect(await db.rows('SELECT str_registration_id FROM listings WHERE is_current')).toEqual([
      { str_registration_id: null },
    ]);
    expect(await db.rows('SELECT valid_from, valid_to FROM listings ORDER BY valid_from')).toEqual([
      { valid_from: '2026-08-26', valid_to: '2026-08-27' },
      { valid_from: '2026-08-27', valid_to: null },
    ]);
  });

  it('do not open a version a day just for being re-read', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    const read = page('1', { locationIsExact: true, locationSource: 'json-ld+state' });
    for (const day of ['2026-08-26', '2026-08-27', '2026-08-28']) {
      await recordObservations(db, day, parsed, [read]);
    }

    expect(await db.count('SELECT count(*) FROM listings')).toBe(1);
    // page_seen_date still advances.
    expect(await db.rows('SELECT page_seen_date FROM listings')).toEqual([
      { page_seen_date: '2026-08-28' },
    ]);
  });

  it('open a new version when a host publishes their registration number', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { locationIsExact: true })]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { locationIsExact: true, strRegistrationId: 'STR20260001' }),
    ]);

    expect(stats.changed).toBe(1);
    expect(
      await db.rows(
        'SELECT str_registration_id, valid_from, valid_to, is_current FROM listings ' +
          'ORDER BY valid_from',
      ),
    ).toEqual([
      {
        str_registration_id: null,
        valid_from: '2026-08-26',
        valid_to: '2026-08-27',
        is_current: false,
      },
      {
        str_registration_id: 'STR20260001',
        valid_from: '2026-08-27',
        valid_to: null,
        is_current: true,
      },
    ]);
  });
});

// --------------------------------------------------------------------------
// calendar

describe('mergeCalendar', () => {
  it('detects changes and closes the previous version', async () => {
    const { db } = await freshDb();

    const open = [calendar('1', [night('2026-09-01', true, 2, 150)])];
    expect((await mergeCalendar(db, '2026-08-01', open)).nightsChanged).toBe(1);

    // Same value again: no new version.
    expect((await mergeCalendar(db, '2026-08-02', open)).nightsChanged).toBe(0);

    // Flips to booked: new version, old one closed.
    const booked = [calendar('1', [night('2026-09-01', false, 2, null)])];
    expect((await mergeCalendar(db, '2026-08-03', booked)).nightsChanged).toBe(1);

    expect(
      await db.rows(
        'SELECT available, valid_from, valid_to, is_current FROM calendar_status ' +
          "WHERE listing_id = 1 AND night_date = '2026-09-01' ORDER BY valid_from",
      ),
    ).toEqual([
      { available: true, valid_from: '2026-08-01', valid_to: '2026-08-03', is_current: false },
      { available: false, valid_from: '2026-08-03', valid_to: null, is_current: true },
    ]);
  });

  it('excludes a failed fetch', async () => {
    const { db } = await freshDb();
    const stats = await mergeCalendar(db, '2026-08-01', [
      calendar('1', [night('2026-09-01', true, 1, 100)]),
      calendar('2', [], 'timeout'),
    ]);

    expect(stats.attempted).toBe(2);
    expect(stats.failed).toBe(1);
    expect(await db.count('SELECT count(*) FROM calendar_status WHERE listing_id = 2')).toBe(0);
  });
});

describe('calendar_current', () => {
  const nights = [night('2026-08-05', true, 2, 100), night('2027-01-01', true, 2, 100)];

  it('drops a retired listing’s unconfirmed future', async () => {
    const { db } = await freshDb();
    const start = '2026-08-01';
    await recordObservations(db, start, [makeListing(1, 'A'), makeListing(2, 'B')]);
    await mergeCalendar(db, start, [calendar('1', nights), calendar('2', nights)]);

    // Listing 2 vanishes; listing 1 keeps being seen and keeps reporting.
    for (let i = 1; i < 10; i++) {
      const day = addDays(start, i);
      await recordObservations(db, day, [makeListing(1, 'A')]);
      await mergeCalendar(db, day, [calendar('1', nights)]);
    }

    const operating = (view: string): Promise<number> =>
      db.count(
        `SELECT count(DISTINCT listing_id) FROM ${view} ` +
          "WHERE is_current AND night_date = '2027-01-01'",
      );

    expect(await operating('calendar_status')).toBe(2); // the raw table still holds both
    expect(await operating('calendar_current')).toBe(1); // only listing 1 is still live
  });

  it('keeps a retired listing’s nights up to its last sighting', async () => {
    const { db } = await freshDb();
    const start = '2026-08-01';
    const past = [night('2026-08-01', false, 2, 100)];
    await recordObservations(db, start, [makeListing(1, 'A'), makeListing(2, 'B')]);
    await mergeCalendar(db, start, [calendar('1', past), calendar('2', past)]);
    for (let i = 1; i < 10; i++) {
      await recordObservations(db, addDays(start, i), [makeListing(1, 'A')]);
    }

    expect(await db.value('SELECT is_current FROM listings WHERE listing_id = 2')).toBe(false);
    expect(
      await db.count("SELECT count(*) FROM calendar_current WHERE night_date = '2026-08-01'"),
    ).toBe(2);
  });
});

// --------------------------------------------------------------------------
// schema, transactions, run log

describe('the store itself', () => {
  it('rejects a database with listings as a table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-'));
    temporary.push(dir);
    const path = join(dir, 'legacy.duckdb');

    const { Database } = await import('../src/db.ts');
    const legacy = await Database.open(path);
    await legacy.run('CREATE TABLE listings (listing_id BIGINT, is_current BOOLEAN)');
    legacy.close();

    await expect(connect(path)).rejects.toThrow(LegacySchemaError);
    await expect(connect(path)).rejects.toThrow(/as a table rather than a view/);
  });

  it('round-trips a run row', async () => {
    const { db } = await freshDb();
    await logRun(db, runRow('2026-08-01', { listingsSeen: 3, listingsNew: 3 }));

    expect(await db.rows('SELECT listings_seen, error_summary FROM scrape_runs')).toEqual([
      { listings_seen: 3, error_summary: null },
    ]);
  });
});

describe('transactions', () => {
  it('roll back a partial run', async () => {
    const { db } = await freshDb();

    await expect(
      db.transaction(async () => {
        await recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')]);
        throw new Error('calendar merge blew up');
      }),
    ).rejects.toThrow('calendar merge blew up');

    expect(await db.count('SELECT count(*) FROM listing_observations')).toBe(0);
    expect(await db.count('SELECT count(*) FROM listings')).toBe(0);
  });

  it('keep the previous day intact on rollback', async () => {
    const { db } = await freshDb();
    await db.transaction(() => recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')]));

    await expect(
      db.transaction(async () => {
        await recordObservations(db, '2026-08-27', [makeListing(1, 'Cabin A Renamed')]);
        throw new Error('died after writing the new day');
      }),
    ).rejects.toThrow();

    expect(
      await db.rows('SELECT name, valid_to, is_current FROM listings WHERE listing_id = 1'),
    ).toEqual([{ name: 'Cabin A', valid_to: null, is_current: true }]);
  });

  it('commit on success, durably', async () => {
    const { db, path } = await freshDb();
    await db.transaction(() => recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')]));
    db.close();
    open.length = 0;

    const reopened = await connect(path);
    open.push(reopened);
    expect(await reopened.count('SELECT count(*) FROM listings WHERE is_current')).toBe(1);
  });

  it('let the failed-run row survive the rollback', async () => {
    // The pipeline writes the failed-run row after the rollback.
    const { db } = await freshDb();
    await expect(
      db.transaction(async () => {
        await recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')]);
        throw new Error('boom');
      }),
    ).rejects.toThrow();

    await logRun(
      db,
      runRow('2026-08-26', {
        listingsSeen: null,
        listingsNew: null,
        listingsChanged: null,
        listingsRetired: null,
        errorSummary: 'Error: boom',
      }),
    );

    expect(await db.count('SELECT count(*) FROM listings')).toBe(0);
    expect(await db.rows('SELECT error_summary, listings_seen FROM scrape_runs')).toEqual([
      { error_summary: 'Error: boom', listings_seen: null },
    ]);
  });
});
