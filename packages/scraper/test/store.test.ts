import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import { RETIREMENT_GRACE_DAYS } from '@anchorage-str-db/db/views';
import type { CalendarNight, CalendarResult } from '@anchorage-str-db/scraper-airbnb/calendars';
import {
  collectHostCards,
  emptyListingPage,
  type HostCard,
  type ListingPage,
} from '@anchorage-str-db/scraper-airbnb/listingPage';
import type { PriceQuote } from '@anchorage-str-db/scraper-airbnb/priceQuotes';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

import {
  logRun,
  mergeCalendar,
  pendingFirstReviews,
  recordFirstReviews,
  recordHostObservations,
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

function page(listingId: string, fields: Partial<ListingPage> = {}): ListingPage {
  return { ...emptyListingPage(listingId), ...fields };
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
    firstReviewFetchAttempted: null,
    firstReviewFetchFailed: null,
    quoteFetchAttempted: null,
    quoteFetchFailed: null,
    hostProfileAttempted: null,
    hostProfileFailed: null,
    errorSummary: null,
    ...overrides,
  };
}

function night(nightDate: IsoDate, available: boolean, minNights: number | null): CalendarNight {
  return {
    nightDate,
    available,
    minNights,
    availableForCheckin: available,
    availableForCheckout: true,
    maxNights: null,
  };
}

function calendar(listingId: string, nights: CalendarNight[], error: string | null = null): CalendarResult {
  return { listingId, nights, error };
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
    expect(await db.count('SELECT count(*) FROM airbnb_listing_observations')).toBe(4);
    expect(await db.count('SELECT count(*) FROM listings WHERE is_active')).toBe(2);
  });

  it('detects an attribute change', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-01', [makeListing(1, 'Cabin A')]);
    const stats = await recordObservations(db, '2026-08-02', [makeListing(1, 'Cabin A Renamed')]);

    expect(stats.changed).toBe(1);
    expect(stats.new).toBe(0);
    expect(
      await db.rows(
        'SELECT name, valid_from, valid_to, is_active FROM listings ' +
          'WHERE listing_id = 1 ORDER BY valid_from',
      ),
    ).toEqual([
      { name: 'Cabin A', valid_from: '2026-08-01', valid_to: '2026-08-02', is_active: false },
      { name: 'Cabin A Renamed', valid_from: '2026-08-02', valid_to: null, is_active: true },
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
      await db.rows('SELECT review_count FROM airbnb_listing_observations ORDER BY scrape_date'),
    ).toEqual([{ review_count: 10 }, { review_count: 99 }]);
  });

  it('is idempotent per day', async () => {
    const { db } = await freshDb();
    const listings = [makeListing(1, 'A'), makeListing(2, 'B')];
    const first = await recordObservations(db, '2026-08-01', listings);
    const again = await recordObservations(db, '2026-08-01', listings);

    expect(await db.count('SELECT count(*) FROM airbnb_listing_observations')).toBe(2);
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
    expect(await db.rows('SELECT listing_id, is_active FROM listings ORDER BY listing_id')).toEqual(
      [
        { listing_id: '1', is_active: true },
        { listing_id: '2', is_active: false },
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

    expect(await db.count('SELECT count(*) FROM listings WHERE is_active')).toBe(0);
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

    expect(await db.count('SELECT count(*) FROM listings WHERE is_active')).toBe(1);
  });

  it('keeps a listing’s history when it comes back', async () => {
    const { db } = await freshDb();
    const read = page('1', { locationIsExact: true, registrationId: 'STR20260001' });
    await recordObservations(db, '2026-08-01', [makeListing(1, 'Cabin A')], [read]);

    for (let i = 2; i < 12; i++) {
      // gone long enough to be retired
      const day = `2026-08-${String(i).padStart(2, '0')}`;
      await recordObservations(db, day, []);
      await logRun(db, runRow(day, { listingsSeen: 0 }));
    }
    expect(await db.count('SELECT count(*) FROM listings WHERE is_active')).toBe(0);

    await recordObservations(db, '2026-08-20', [makeListing(1, 'Cabin A')], [read]);

    expect(
      await db.rows(
        'SELECT first_seen_date, last_seen_date, registration_id, is_active ' +
          'FROM listings WHERE listing_id = 1',
      ),
    ).toEqual([
      {
        first_seen_date: '2026-08-01',
        last_seen_date: '2026-08-20',
        registration_id: 'STR20260001',
        is_active: true,
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
          registrationId: 'STR20260001',
          locationSource: 'json-ld+state',
        }),
        page('2', { locationIsExact: false, locationSource: 'json-ld+state' }),
      ],
    );

    expect(
      await db.rows(
        'SELECT listing_id, location_is_exact, registration_id, page_seen_date ' +
          'FROM listings WHERE is_active ORDER BY listing_id',
      ),
    ).toEqual([
      {
        listing_id: '1',
        location_is_exact: true,
        registration_id: 'STR20260001',
        page_seen_date: '2026-08-26',
      },
      {
        listing_id: '2',
        location_is_exact: false,
        registration_id: null,
        page_seen_date: '2026-08-26',
      },
    ]);
  });

  it('carry forward rather than blanking on a run without pages', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [
      page('1', { locationIsExact: true, registrationId: 'STR20260001' }),
    ]);

    const stats = await recordObservations(db, '2026-08-27', parsed);

    expect(stats.changed).toBe(0);
    expect(await db.count('SELECT count(*) FROM listings')).toBe(1);
    expect(
      await db.rows(
        'SELECT location_is_exact, registration_id FROM listings WHERE is_active',
      ),
    ).toEqual([{ location_is_exact: true, registration_id: 'STR20260001' }]);
  });

  it('carry forward past a failed page fetch too', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { locationIsExact: true })]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { error: 'HttpError: HTTP 429' }),
    ]);

    expect(stats.changed).toBe(0);
    expect(await db.rows('SELECT location_is_exact FROM listings WHERE is_active')).toEqual([
      { location_is_exact: true },
    ]);
    // The raw row records the failure; only the view carries values forward.
    expect(
      await db.rows(
        "SELECT page_fetch_ok, location_is_exact FROM airbnb_listing_observations " +
          "WHERE scrape_date = '2026-08-27'",
      ),
    ).toEqual([{ page_fetch_ok: false, location_is_exact: null }]);
  });

  it('do not resurrect a removed registration id after a later failure', async () => {
    // A failed fetch carries forward the last read ("no number"), not the
    // last non-null number.
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [
      page('1', { locationIsExact: true, registrationId: 'STR20260001' }),
    ]);
    // Read the page; the host has taken the number down.
    await recordObservations(db, '2026-08-27', parsed, [page('1', { locationIsExact: true })]);
    // Now a failed fetch.
    await recordObservations(db, '2026-08-28', parsed, [
      page('1', { error: 'HttpError: HTTP 429' }),
    ]);

    expect(await db.rows('SELECT registration_id FROM listings WHERE is_active')).toEqual([
      { registration_id: null },
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

  it('open a new version when a host publishes their registration id', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { locationIsExact: true })]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { locationIsExact: true, registrationId: 'STR20260001' }),
    ]);

    expect(stats.changed).toBe(1);
    expect(
      await db.rows(
        'SELECT registration_id, valid_from, valid_to, is_active FROM listings ' +
          'ORDER BY valid_from',
      ),
    ).toEqual([
      {
        registration_id: null,
        valid_from: '2026-08-26',
        valid_to: '2026-08-27',
        is_active: false,
      },
      {
        registration_id: 'STR20260001',
        valid_from: '2026-08-27',
        valid_to: null,
        is_active: true,
      },
    ]);
  });

  it('store a 19-digit host id exactly', async () => {
    const { db } = await freshDb();
    await recordObservations(
      db,
      '2026-08-26',
      [makeListing(1, 'Cabin A')],
      [page('1', { hostId: '1726975321647428715' })],
    );

    expect(await db.rows('SELECT host_id FROM listings WHERE is_active')).toEqual([
      { host_id: '1726975321647428715' },
    ]);
  });

  it('carry the host id forward past a failed page fetch', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { hostId: '3682901' })]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { error: 'HttpError: HTTP 503' }),
    ]);

    expect(stats.changed).toBe(0);
    expect(await db.rows('SELECT host_id FROM listings WHERE is_active')).toEqual([
      { host_id: '3682901' },
    ]);
  });

  it('open a new version when the listing changes hosts', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { hostId: '3682901' })]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { hostId: '42437515' }),
    ]);

    expect(stats.changed).toBe(1);
    expect(
      await db.rows('SELECT host_id, valid_from, valid_to FROM listings ORDER BY valid_from'),
    ).toEqual([
      { host_id: '3682901', valid_from: '2026-08-26', valid_to: '2026-08-27' },
      { host_id: '42437515', valid_from: '2026-08-27', valid_to: null },
    ]);
  });
});

describe('room type and counts', () => {
  const entireHome = {
    roomType: 'Entire home/apt',
    guestCapacity: 6,
    beds: 3,
    bedrooms: '2 bedrooms',
    bathrooms: '1.5 baths',
  } as const;

  it('land on the listing row', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')], [page('1', entireHome)]);

    expect(
      await db.rows(
        'SELECT room_type, guest_capacity, beds, bedrooms, bathrooms FROM listings WHERE is_active',
      ),
    ).toEqual([
      {
        room_type: 'Entire home/apt',
        guest_capacity: 6,
        beds: 3,
        bedrooms: '2 bedrooms',
        bathrooms: '1.5 baths',
      },
    ]);
  });

  it('carry forward past a failed page fetch', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', entireHome)]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { error: 'HttpError: HTTP 503' }),
    ]);

    expect(stats.changed).toBe(0);
    expect(
      await db.rows('SELECT room_type, beds, bathrooms FROM listings WHERE is_active'),
    ).toEqual([{ room_type: 'Entire home/apt', beds: 3, bathrooms: '1.5 baths' }]);
  });

  it.each([
    ['a whole home converting to a rented room', { roomType: 'Private room' }],
    ['a change of guest capacity', { guestCapacity: 8 }],
    ['a change of bed count', { beds: 4 }],
    ['a change of bedrooms', { bedrooms: '3 bedrooms' }],
    ['a change of bathrooms', { bathrooms: '2 baths' }],
  ] as const)('open a new version for %s', async (_, change) => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', entireHome)]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { ...entireHome, ...change }),
    ]);

    expect(stats.changed).toBe(1);
    expect(
      await db.rows('SELECT valid_from, valid_to FROM listings ORDER BY valid_from'),
    ).toEqual([
      { valid_from: '2026-08-26', valid_to: '2026-08-27' },
      { valid_from: '2026-08-27', valid_to: null },
    ]);
  });
});

describe('price quotes', () => {
  function quote(listingId: string, fields: Partial<PriceQuote> = {}): PriceQuote {
    return {
      listingId,
      checkIn: '2026-09-01',
      nights: 2,
      label: '$241 for 2 nights, originally $269',
      total: 241,
      breakdown: ['2 nights x $120.50: $241.00'],
      error: null,
      ...fields,
    };
  }

  it('land on the observation row', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')], [], [quote('1')]);

    expect(
      await db.rows(
        'SELECT quote_check_in, quote_nights, quote_total, quote_label, quote_breakdown ' +
          'FROM airbnb_listing_observations',
      ),
    ).toEqual([
      {
        quote_check_in: '2026-09-01',
        quote_nights: 2,
        quote_total: 241,
        quote_label: '$241 for 2 nights, originally $269',
        quote_breakdown: ['2 nights x $120.50: $241.00'],
      },
    ]);
  });

  it('keep Airbnb’s reason when a stay has no price', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')], [], [
      quote('1', { total: null, label: 'Those dates are not available', breakdown: [] }),
    ]);

    expect(await db.rows('SELECT quote_total, quote_label FROM airbnb_listing_observations')).toEqual([
      { quote_total: null, quote_label: 'Those dates are not available' },
    ]);
  });

  it('are NULL for a failed quote', async () => {
    const { db } = await freshDb();
    await recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')], [], [
      quote('1', { total: null, label: null, breakdown: [], error: 'HttpError: HTTP 503' }),
    ]);

    expect(await db.rows('SELECT quote_check_in, quote_total FROM airbnb_listing_observations')).toEqual([
      { quote_check_in: null, quote_total: null },
    ]);
  });

  it('never open a listing version', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [], [quote('1')]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [], [quote('1', { total: 999 })]);

    expect(stats.changed).toBe(0);
  });
});

describe('airbnb_listing_photos', () => {
  const urls = (...ids: number[]): string[] =>
    ids.map((id) => `https://a0.muscache.com/im/pictures/${id}.jpeg`);

  async function photoRows(db: Database): Promise<unknown[]> {
    return db.rows(
      'SELECT valid_from, photo_urls FROM airbnb_listing_photos WHERE listing_id = 1 ORDER BY valid_from',
    );
  }

  it('stores a set only when it differs from the listing’s previous one', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { photoUrls: urls(1, 2) })]);
    await recordObservations(db, '2026-08-27', parsed, [page('1', { photoUrls: urls(1, 2) })]);
    await recordObservations(db, '2026-08-28', parsed, [page('1', { photoUrls: urls(2, 1) })]);

    expect(await photoRows(db)).toEqual([
      { valid_from: '2026-08-26', photo_urls: urls(1, 2) },
      // A reorder changes the cover photo, so it is a new set.
      { valid_from: '2026-08-28', photo_urls: urls(2, 1) },
    ]);
  });

  it('keeps the previous set current when a page yields none', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { photoUrls: urls(1, 2) })]);
    await recordObservations(db, '2026-08-27', parsed, [page('1')]);
    await recordObservations(db, '2026-08-28', parsed, [page('1', { error: 'timeout' })]);

    expect(
      await db.rows('SELECT photo_urls, photo_count, photos_valid_from FROM listing_photos_current'),
    ).toEqual([{ photo_urls: urls(1, 2), photo_count: 2, photos_valid_from: '2026-08-26' }]);
  });

  it('never opens a listing version', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { photoUrls: urls(1) })]);

    const stats = await recordObservations(db, '2026-08-27', parsed, [
      page('1', { photoUrls: urls(3, 4, 5) }),
    ]);

    expect(stats.changed).toBe(0);
    expect(await db.count('SELECT count(*) FROM listings')).toBe(1);
  });

  it('is idempotent per day', async () => {
    const { db } = await freshDb();
    const parsed = [makeListing(1, 'Cabin A')];
    await recordObservations(db, '2026-08-26', parsed, [page('1', { photoUrls: urls(1) })]);
    await recordObservations(db, '2026-08-27', parsed, [page('1', { photoUrls: urls(2) })]);
    // Re-running the second day with the first day's set writes nothing new.
    await recordObservations(db, '2026-08-27', parsed, [page('1', { photoUrls: urls(1) })]);

    expect(await photoRows(db)).toEqual([{ valid_from: '2026-08-26', photo_urls: urls(1) }]);
  });
});

// --------------------------------------------------------------------------
// hosts

function card(hostId: string, overrides: Partial<HostCard> = {}): HostCard {
  return {
    hostId,
    name: 'Rachel',
    about: 'Born and raised in Girdwood.',
    timeAsHostYears: 9,
    timeAsHostMonths: 7,
    ...overrides,
  };
}

/**
 * One listing per entry, observed on `day` with the page outcome given:
 * a card, `'no-card'` (page read, card unreadable), or `'failed'`.
 */
interface Held {
  listingId: number;
  hostId: string;
  page: HostCard | 'no-card' | 'failed';
}

async function recordDay(db: Database, day: IsoDate, held: readonly Held[]): Promise<void> {
  const pages = held.map(({ listingId, hostId, page: outcome }) =>
    outcome === 'failed'
      ? page(String(listingId), { error: 'HttpError: HTTP 503' })
      : page(String(listingId), { hostId, hostCard: outcome === 'no-card' ? null : outcome }),
  );
  await recordObservations(
    db,
    day,
    held.map(({ listingId }) => makeListing(listingId, `Cabin ${listingId}`)),
    pages,
  );
  await recordHostObservations(db, day, collectHostCards(pages));
  await logRun(db, runRow(day, { listingsSeen: held.length }));
}

describe('hosts', () => {
  it('stores one row per host per day, however many listings they hold', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [
      { listingId: 1, hostId: '100', page: card('100') },
      { listingId: 2, hostId: '100', page: card('100') },
      { listingId: 3, hostId: '200', page: card('200', { name: 'Alyeska Cabins LLC', about: null }) },
    ]);

    expect(
      await db.rows(
        'SELECT host_id, profile_read_ok, name, about FROM airbnb_host_observations ORDER BY host_id',
      ),
    ).toEqual([
      { host_id: '100', profile_read_ok: true, name: 'Rachel', about: 'Born and raised in Girdwood.' },
      { host_id: '200', profile_read_ok: true, name: 'Alyeska Cabins LLC', about: null },
    ]);
  });

  it('derives the hosting start date and years hosting', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-09-12', [{ listingId: 1, hostId: '100', page: card('100') }]);

    expect(
      await db.rows(
        'SELECT hosting_started_on, hosting_started_year, years_hosting, hosting_start_spread_days ' +
          'FROM hosts',
      ),
    ).toEqual([
      {
        hosting_started_on: '2017-02-12',
        hosting_started_year: 2017,
        years_hosting: 9,
        hosting_start_spread_days: 0,
      },
    ]);
  });

  it('takes the earliest start date across readings a month apart', async () => {
    const { db } = await freshDb();
    // A host who started 2017-02-05 reads 9y7m on 09-12 and 9y8m on 10-05,
    // implying 2017-02-12 and 2017-02-05.
    await recordDay(db, '2026-09-12', [{ listingId: 1, hostId: '100', page: card('100') }]);
    await recordDay(db, '2026-10-05', [
      { listingId: 1, hostId: '100', page: card('100', { timeAsHostMonths: 8 }) },
    ]);

    expect(await db.rows('SELECT hosting_started_on, hosting_start_spread_days FROM hosts')).toEqual([
      { hosting_started_on: '2017-02-05', hosting_start_spread_days: 7 },
    ]);
  });

  it('opens a version when the name or bio changes, not when tenure grows', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [{ listingId: 1, hostId: '100', page: card('100') }]);
    await recordDay(db, '2026-09-01', [
      { listingId: 1, hostId: '100', page: card('100', { timeAsHostMonths: 8 }) },
    ]);
    await recordDay(db, '2026-09-02', [
      { listingId: 1, hostId: '100', page: card('100', { timeAsHostMonths: 8, about: 'New bio.' }) },
    ]);

    expect(
      await db.rows('SELECT about, valid_from, valid_to, is_active FROM hosts ORDER BY valid_from'),
    ).toEqual([
      {
        about: 'Born and raised in Girdwood.',
        valid_from: '2026-08-01',
        valid_to: '2026-09-02',
        is_active: false,
      },
      { about: 'New bio.', valid_from: '2026-09-02', valid_to: null, is_active: true },
    ]);
  });

  it('carries the profile forward past a failed page fetch', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [{ listingId: 1, hostId: '100', page: card('100') }]);
    await recordDay(db, '2026-08-02', [{ listingId: 1, hostId: '100', page: 'failed' }]);

    // The owner is known from the listing's carried-forward host_id, so the
    // day still gets a row, marked unread.
    expect(
      await db.rows(
        "SELECT profile_read_ok, name FROM airbnb_host_observations WHERE scrape_date = '2026-08-02'",
      ),
    ).toEqual([{ profile_read_ok: false, name: null }]);
    expect(
      await db.rows(
        'SELECT name, about, version_no, profile_seen_date, last_seen_date, is_active FROM hosts',
      ),
    ).toEqual([
      {
        name: 'Rachel',
        about: 'Born and raised in Girdwood.',
        version_no: '1',
        profile_seen_date: '2026-08-01',
        last_seen_date: '2026-08-02',
        is_active: true,
      },
    ]);
  });

  it('does not resurrect a removed bio after a later failure', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [{ listingId: 1, hostId: '100', page: card('100') }]);
    await recordDay(db, '2026-08-02', [
      { listingId: 1, hostId: '100', page: card('100', { about: null }) },
    ]);
    await recordDay(db, '2026-08-03', [{ listingId: 1, hostId: '100', page: 'failed' }]);

    expect(await db.rows('SELECT about, valid_from FROM hosts WHERE is_active')).toEqual([
      { about: null, valid_from: '2026-08-02' },
    ]);
  });

  it('reports attempted, failed, new and changed', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [{ listingId: 1, hostId: '100', page: card('100') }]);

    const pages = [
      page('1', { error: 'HttpError: HTTP 503' }),
      page('2', { hostId: '200', hostCard: card('200') }),
    ];
    await recordObservations(db, '2026-08-02', [makeListing(1, 'Cabin 1'), makeListing(2, 'Cabin 2')], pages);
    const stats = await recordHostObservations(db, '2026-08-02', collectHostCards(pages));

    expect(stats).toEqual({ attempted: 2, failed: 1, new: 1, changed: 1 });
    // Idempotent per day.
    expect(await recordHostObservations(db, '2026-08-02', collectHostCards(pages))).toEqual(stats);
    expect(await db.count('SELECT count(*) FROM airbnb_host_observations')).toBe(3);
  });

  it('keeps the lowest listing id’s card when a host’s pages disagree', () => {
    const cards = collectHostCards([
      page('20', { hostId: '100', hostCard: card('100', { name: 'Later' }) }),
      page('3', { hostId: '100', hostCard: card('100', { name: 'Earlier' }) }),
    ]);

    expect(cards.get('100')?.name).toBe('Earlier');
  });
});

// --------------------------------------------------------------------------
// host portfolios

describe('host_portfolios', () => {
  it('counts a multi-listing host', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [
      { listingId: 1, hostId: '100', page: card('100') },
      { listingId: 2, hostId: '100', page: card('100') },
      { listingId: 3, hostId: '100', page: 'no-card' },
      { listingId: 4, hostId: '200', page: card('200') },
    ]);

    expect(
      await db.rows(
        'SELECT host_id, listings_active, listings_ever_seen FROM host_portfolios ORDER BY host_id',
      ),
    ).toEqual([
      { host_id: '100', listings_active: 3, listings_ever_seen: 3 },
      { host_id: '200', listings_active: 1, listings_ever_seen: 1 },
    ]);
    expect(
      await db.rows(
        'SELECT listing_id, host_name, host_years_hosting, host_listings_active ' +
          'FROM listings_active_with_host ORDER BY listing_id',
      ),
    ).toEqual([
      { listing_id: '1', host_name: 'Rachel', host_years_hosting: 9, host_listings_active: 3 },
      { listing_id: '2', host_name: 'Rachel', host_years_hosting: 9, host_listings_active: 3 },
      { listing_id: '3', host_name: 'Rachel', host_years_hosting: 9, host_listings_active: 3 },
      { listing_id: '4', host_name: 'Rachel', host_years_hosting: 9, host_listings_active: 1 },
    ]);
  });

  it('drops retired listings from the live count but not from ever seen', async () => {
    const { db } = await freshDb();
    const start = '2026-08-01';
    const both: Held[] = [
      { listingId: 1, hostId: '100', page: card('100') },
      { listingId: 2, hostId: '100', page: card('100') },
    ];
    await recordDay(db, start, both);
    // Listing 2 disappears; it is retired after the grace period.
    for (let i = 1; i <= RETIREMENT_GRACE_DAYS + 1; i++) {
      await recordDay(db, addDays(start, i), both.slice(0, 1));
    }

    const rows = await db.rows<{ scrape_date: string; listings_active: number; listings_ever_seen: number }>(
      "SELECT scrape_date, listings_active, listings_ever_seen FROM host_portfolios WHERE host_id = 100 ORDER BY scrape_date",
    );
    expect(rows[RETIREMENT_GRACE_DAYS]).toEqual({
      scrape_date: addDays(start, RETIREMENT_GRACE_DAYS),
      listings_active: 2,
      listings_ever_seen: 2,
    });
    expect(rows.at(-1)).toEqual({
      scrape_date: addDays(start, RETIREMENT_GRACE_DAYS + 1),
      listings_active: 1,
      listings_ever_seen: 2,
    });
  });

  it('tracks a host who gains listings over time', async () => {
    const { db } = await freshDb();
    const holding = (n: number): Held[] =>
      [...Array(n).keys()].map((i) => ({ listingId: i + 1, hostId: '100', page: card('100') }));
    await recordDay(db, '2026-08-01', holding(1));
    await recordDay(db, '2026-08-02', holding(3));
    await recordDay(db, '2026-08-03', holding(14));

    expect(
      await db.rows(
        'SELECT scrape_date, listings_active, listings_ever_seen FROM host_portfolios ORDER BY scrape_date',
      ),
    ).toEqual([
      { scrape_date: '2026-08-01', listings_active: 1, listings_ever_seen: 1 },
      { scrape_date: '2026-08-02', listings_active: 3, listings_ever_seen: 3 },
      { scrape_date: '2026-08-03', listings_active: 14, listings_ever_seen: 14 },
    ]);
  });

  it('keeps a listing in its host’s portfolio past a failed page fetch', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [{ listingId: 1, hostId: '100', page: card('100') }]);
    await recordDay(db, '2026-08-02', [{ listingId: 1, hostId: '100', page: 'failed' }]);

    expect(
      await db.rows("SELECT listings_active FROM host_portfolios WHERE scrape_date = '2026-08-02'"),
    ).toEqual([{ listings_active: 1 }]);
  });

  it('moves a listing that changes hands', async () => {
    const { db } = await freshDb();
    await recordDay(db, '2026-08-01', [{ listingId: 1, hostId: '100', page: card('100') }]);
    await recordDay(db, '2026-08-02', [{ listingId: 1, hostId: '200', page: card('200') }]);

    expect(
      await db.rows(
        "SELECT host_id, listings_active, listings_ever_seen FROM host_portfolios " +
          "WHERE scrape_date = '2026-08-02' ORDER BY host_id",
      ),
    ).toEqual([
      { host_id: '100', listings_active: 0, listings_ever_seen: 1 },
      { host_id: '200', listings_active: 1, listings_ever_seen: 1 },
    ]);
  });

  it('stores counts only, with the scope caveat in the file', async () => {
    const { db } = await freshDb();

    expect(
      await db.rows(
        "SELECT column_name FROM duckdb_columns() WHERE table_name = 'host_portfolios' " +
          'ORDER BY column_index',
      ),
    ).toEqual([
      { column_name: 'host_id' },
      { column_name: 'scrape_date' },
      { column_name: 'listings_active' },
      { column_name: 'listings_ever_seen' },
    ]);
    expect(
      await db.value("SELECT comment FROM duckdb_views() WHERE view_name = 'host_portfolios'"),
    ).toMatch(/Anchorage search area/);
  });
});

// --------------------------------------------------------------------------
// calendar

describe('mergeCalendar', () => {
  it('detects changes and closes the previous version', async () => {
    const { db } = await freshDb();

    const open = [calendar('1', [night('2026-09-01', true, 2)])];
    expect((await mergeCalendar(db, '2026-08-01', open)).nightsChanged).toBe(1);

    // Same value again: no new version.
    expect((await mergeCalendar(db, '2026-08-02', open)).nightsChanged).toBe(0);

    // Flips to booked: new version, old one closed.
    const booked = [calendar('1', [night('2026-09-01', false, 2)])];
    expect((await mergeCalendar(db, '2026-08-03', booked)).nightsChanged).toBe(1);

    expect(
      await db.rows(
        'SELECT available, valid_from, valid_to, is_current FROM airbnb_calendar_status ' +
          "WHERE listing_id = 1 AND night_date = '2026-09-01' ORDER BY valid_from",
      ),
    ).toEqual([
      { available: true, valid_from: '2026-08-01', valid_to: '2026-08-03', is_current: false },
      { available: false, valid_from: '2026-08-03', valid_to: null, is_current: true },
    ]);
  });

  it('hashes a night as available|min_nights|, the format of every stored row', async () => {
    const { db } = await freshDb();
    await mergeCalendar(db, '2026-08-01', [calendar('1', [night('2026-09-01', true, 2)])]);

    expect(await db.value('SELECT status_hash FROM airbnb_calendar_status')).toBe(
      await db.value("SELECT md5('true|2|')"),
    );
  });

  it('excludes a failed fetch', async () => {
    const { db } = await freshDb();
    const stats = await mergeCalendar(db, '2026-08-01', [
      calendar('1', [night('2026-09-01', true, 1)]),
      calendar('2', [], 'timeout'),
    ]);

    expect(stats.attempted).toBe(2);
    expect(stats.failed).toBe(1);
    expect(await db.count('SELECT count(*) FROM airbnb_calendar_status WHERE listing_id = 2')).toBe(0);
  });
});

describe('calendar_current', () => {
  const nights = [night('2026-08-05', true, 2), night('2027-01-01', true, 2)];

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

    expect(await operating('airbnb_calendar_status')).toBe(2); // the raw table still holds both
    expect(await operating('calendar_current')).toBe(1); // only listing 1 is still active
  });

  it('keeps a retired listing’s nights up to its last sighting', async () => {
    const { db } = await freshDb();
    const start = '2026-08-01';
    const past = [night('2026-08-01', false, 2)];
    await recordObservations(db, start, [makeListing(1, 'A'), makeListing(2, 'B')]);
    await mergeCalendar(db, start, [calendar('1', past), calendar('2', past)]);
    for (let i = 1; i < 10; i++) {
      await recordObservations(db, addDays(start, i), [makeListing(1, 'A')]);
    }

    expect(await db.value('SELECT is_active FROM listings WHERE listing_id = 2')).toBe(false);
    expect(
      await db.count("SELECT count(*) FROM calendar_current WHERE night_date = '2026-08-01'"),
    ).toBe(2);
  });
});

// --------------------------------------------------------------------------
// first reviews

describe('first reviews', () => {
  it('stay pending until resolved, then are never pending again', async () => {
    const { db } = await freshDb();
    const listings = [makeListing(3, 'C'), makeListing(1, 'A'), makeListing(2, 'B')];
    await recordObservations(db, '2026-09-01', listings);

    expect((await pendingFirstReviews(db, listings)).map((c) => c.listingId)).toEqual(['1', '2', '3']);

    await recordFirstReviews(db, '2026-09-01', [
      { listingId: '1', firstReviewDate: '2021-05-04', error: null },
      { listingId: '2', firstReviewDate: null, error: null },
      { listingId: '3', firstReviewDate: null, error: 'HTTP 500' },
    ]);

    // A listing with no reviews is resolved; a failed fetch is retried.
    expect(await pendingFirstReviews(db, listings)).toEqual([
      { listingId: '3', reviewCountHint: 10 },
    ]);
    expect(
      await db.rows('SELECT * FROM airbnb_listing_first_reviews ORDER BY listing_id'),
    ).toEqual([
      { listing_id: '1', first_review_date: '2021-05-04', resolved_date: '2026-09-01' },
      { listing_id: '2', first_review_date: null, resolved_date: '2026-09-01' },
    ]);
  });

  it('refuse to resolve a listing twice', async () => {
    const { db } = await freshDb();
    const result = { listingId: '1', firstReviewDate: '2021-05-04', error: null };
    await recordFirstReviews(db, '2026-09-01', [result]);

    await expect(recordFirstReviews(db, '2026-09-02', [result])).rejects.toThrow();
  });

  it('give listings a first_available_date_est no later than first_seen_date', async () => {
    const { db } = await freshDb();
    const listings = [1, 2, 3, 4].map((id) => makeListing(id, `Cabin ${id}`));
    await recordObservations(db, '2026-09-01', listings);
    await recordFirstReviews(db, '2026-09-01', [
      { listingId: '1', firstReviewDate: '2021-05-04', error: null },
      { listingId: '2', firstReviewDate: null, error: null },
      // A review dated after first sighting, e.g. from a timezone edge.
      { listingId: '3', firstReviewDate: '2026-09-02', error: null },
    ]);

    expect(
      await db.rows(
        'SELECT listing_id, first_review_date, first_available_date_est FROM listings ' +
          'ORDER BY listing_id',
      ),
    ).toEqual([
      { listing_id: '1', first_review_date: '2021-05-04', first_available_date_est: '2021-05-04' },
      { listing_id: '2', first_review_date: null, first_available_date_est: '2026-09-01' },
      { listing_id: '3', first_review_date: '2026-09-02', first_available_date_est: '2026-09-01' },
      { listing_id: '4', first_review_date: null, first_available_date_est: '2026-09-01' },
    ]);
  });
});

// --------------------------------------------------------------------------
// run log, transactions

describe('the run log', () => {
  it('round-trips a run row', async () => {
    const { db } = await freshDb();
    await logRun(db, runRow('2026-08-01', { listingsSeen: 3, listingsNew: 3 }));

    expect(await db.rows('SELECT listings_seen, error_summary FROM airbnb_scrape_runs')).toEqual([
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

    expect(await db.count('SELECT count(*) FROM airbnb_listing_observations')).toBe(0);
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
      await db.rows('SELECT name, valid_to, is_active FROM listings WHERE listing_id = 1'),
    ).toEqual([{ name: 'Cabin A', valid_to: null, is_active: true }]);
  });

  it('commit on success, durably', async () => {
    const { db, path } = await freshDb();
    await db.transaction(() => recordObservations(db, '2026-08-26', [makeListing(1, 'Cabin A')]));
    db.close();
    open.length = 0;

    const reopened = await connect(path);
    open.push(reopened);
    expect(await reopened.count('SELECT count(*) FROM listings WHERE is_active')).toBe(1);
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
    expect(await db.rows('SELECT error_summary, listings_seen FROM airbnb_scrape_runs')).toEqual([
      { error_summary: 'Error: boom', listings_seen: null },
    ]);
  });
});
