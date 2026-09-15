import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import { collectHostCards, emptyListingPage, type ListingPage } from '@anchorage-str-db/scraper-airbnb/listingPage';
import type { ParsedListing } from '@anchorage-str-db/scraper-airbnb/parse';
import { emptyAudit, PriceBand, type CoverageAudit, type SearchResult } from '@anchorage-str-db/scraper-airbnb/search';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import { PLAUSIBLE_LISTING_COUNT, report, runChecks, type CheckResult } from '../src/checks.ts';
import {
  emptyPageStats,
  type QuoteStats,
  logRun,
  mergeCalendar,
  recordHostObservations,
  recordObservations,
} from '../src/store.ts';
import { makeListing } from './fixtures.ts';
import { calendarResultFor } from './helpers.ts';

const DAY: IsoDate = '2026-08-18';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Enough rows for listing_count_plausible and observations_written_today to
 * pass, plus any `extra` listings.
 */
async function seedMinimal(
  pages: readonly ListingPage[] = [],
  firstReviews: { attempted: number; failed: number } = { attempted: 0, failed: 0 },
  extra: readonly ParsedListing[] = [],
): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-'));
  temporary.push(dir);
  const db = await connect(join(dir, 't.duckdb'));
  open.push(db);

  const [floor] = PLAUSIBLE_LISTING_COUNT;
  const listings = [...[...Array(floor).keys()].map((i) => makeListing(i, `Cabin ${i}`)), ...extra];
  await recordObservations(db, DAY, listings, pages);
  const hostStats = await recordHostObservations(db, DAY, collectHostCards(pages));
  await logRun(db, {
    scrapeDate: DAY,
    runStartedAt: `${DAY} 00:00:00`,
    runFinishedAt: `${DAY} 00:00:00`,
    listingsSeen: floor,
    listingsNew: floor,
    listingsChanged: floor,
    listingsRetired: 0,
    calendarFetchAttempted: floor,
    calendarFetchFailed: 0,
    calendarNightsChanged: 0,
    pageFetchAttempted: null,
    pageFetchFailed: null,
    firstReviewFetchAttempted: firstReviews.attempted,
    firstReviewFetchFailed: firstReviews.failed,
    quoteFetchAttempted: null,
    quoteFetchFailed: null,
    hostProfileAttempted: hostStats.attempted,
    hostProfileFailed: hostStats.failed,
    errorSummary: null,
  });
  return db;
}

/** Run the checks with healthy in-memory pass stats unless overridden. */
async function check(
  db: Database,
  overrides: { searchResult?: SearchResult; coverage?: CoverageAudit; quoteStats?: QuoteStats } = {},
): Promise<{ byName: Record<string, CheckResult>; all: CheckResult[] }> {
  const all = await runChecks(db, DAY, {
    pageStats: emptyPageStats(),
    quoteStats: overrides.quoteStats ?? { attempted: 0, failed: 0, priced: 0 },
    searchResult: overrides.searchResult ?? { listings: [], queries: 9, unresolved: [] },
    coverage: overrides.coverage ?? { boxes: 6, seen: 100, missedIds: [] },
  });
  return { byName: Object.fromEntries(all.map((result) => [result.name, result])), all };
}

it('passes no_backdated_calendar_rows on clean data', async () => {
  const db = await seedMinimal();
  await mergeCalendar(db, DAY, [calendarResultFor('0', '2026-08-18', true, 1)]);

  const { byName } = await check(db);
  expect(byName['no_backdated_calendar_rows']!.passed).toBe(true);
});

it('fails no_backdated_calendar_rows for a night before its valid_from', async () => {
  const db = await seedMinimal();
  // Bypasses `toNights`, which normally drops such nights.
  await mergeCalendar(db, DAY, [calendarResultFor('0', '2026-08-01', false, 1)]);

  const { byName, all } = await check(db);
  expect(byName['no_backdated_calendar_rows']!.passed).toBe(false);
  expect(byName['no_backdated_calendar_rows']!.severity).toBe('error');
  expect(report(all)).toBe(false);
});

it('passes search_coverage when the audit found nothing missing', async () => {
  const db = await seedMinimal();
  const { byName } = await check(db);
  expect(byName['search_coverage']!.passed).toBe(true);
});

it('fails search_coverage when another query shape finds listings we missed', async () => {
  const db = await seedMinimal();
  const coverage: CoverageAudit = {
    boxes: 6,
    seen: 100,
    missedIds: [...Array(20).keys()].map((i) => BigInt(900_000 + i)),
  };

  const { byName, all } = await check(db, { coverage });
  expect(byName['search_coverage']!.passed).toBe(false);
  expect(byName['search_coverage']!.severity).toBe('error');
  expect(byName['search_coverage']!.detail).toContain('20/100');
  expect(report(all)).toBe(false);
});

it('passes search_coverage for a miss rate under the threshold', async () => {
  const db = await seedMinimal();
  const coverage: CoverageAudit = { boxes: 6, seen: 100, missedIds: [900_000n, 900_001n, 900_002n] };

  const { byName } = await check(db, { coverage });
  expect(byName['search_coverage']!.passed).toBe(true);
});

it('warns when the audit did not run', async () => {
  const db = await seedMinimal();

  const { byName, all } = await check(db, { coverage: emptyAudit() });
  expect(byName['search_coverage']!.passed).toBe(false);
  expect(byName['search_coverage']!.severity).toBe('warn');
  expect(report(all)).toBe(true);
});

it('passes search_single_page when every band fit one page', async () => {
  const db = await seedMinimal();
  const { byName } = await check(db);
  expect(byName['search_single_page']!.passed).toBe(true);
});

it('fails search_single_page when a band needed more than one page', async () => {
  const db = await seedMinimal();
  const stuck = new PriceBand(150, 151);

  const { byName, all } = await check(db, {
    searchResult: { listings: [], queries: 40, unresolved: [stuck] },
  });
  expect(byName['search_single_page']!.passed).toBe(false);
  expect(byName['search_single_page']!.severity).toBe('error');
  expect(byName['search_single_page']!.detail).toContain(String(stuck));
  expect(report(all)).toBe(false);
});

it('passes coords_within_municipality when every active listing is inside', async () => {
  const db = await seedMinimal();
  const { byName } = await check(db);
  expect(byName['coords_within_municipality']!.passed).toBe(true);
});

it('warns coords_within_municipality for an active listing outside the Municipality', async () => {
  // Palmer, in the Matanuska-Susitna Borough.
  const palmer = makeListing(99_999, 'Palmer cabin', { lat: 61.6 });
  const db = await seedMinimal([], undefined, [palmer]);

  const { byName, all } = await check(db);
  expect(byName['coords_within_municipality']!.passed).toBe(false);
  expect(byName['coords_within_municipality']!.severity).toBe('warn');
  expect(byName['coords_within_municipality']!.detail).toContain('99999');
  expect(report(all)).toBe(true);
});

/** A complete page read for each of the first `count` seeded listings. */
function pagesRead(count: number, fields: (i: number) => Partial<ListingPage> = () => ({})): ListingPage[] {
  return [...Array(count).keys()].map((i) => ({
    ...emptyListingPage(String(i)),
    hostId: String(1000 + i),
    roomType: 'Entire home/apt',
    guestCapacity: 4,
    beds: 2,
    bedrooms: '1 bedroom',
    bathrooms: '1 bath',
    photoUrls: [`https://a0.muscache.com/im/pictures/${i}.jpeg`],
    ...fields(i),
  }));
}

const PAGE_FIELD_CHECKS = [
  'host_id_coverage',
  'room_type_coverage',
  'guest_capacity_coverage',
  'beds_coverage',
  'bedrooms_coverage',
  'bathrooms_coverage',
];

it('passes the page field checks when every page read has every field', async () => {
  const [floor] = PLAUSIBLE_LISTING_COUNT;
  const db = await seedMinimal(pagesRead(floor));

  const { byName } = await check(db);
  for (const name of PAGE_FIELD_CHECKS) expect(byName[name]!.passed, name).toBe(true);
});

it.each([
  ['host_id_coverage', { hostId: null }],
  ['room_type_coverage', { roomType: null }],
  ['guest_capacity_coverage', { guestCapacity: null }],
  ['beds_coverage', { beds: null }],
  ['bathrooms_coverage', { bathrooms: null }],
] as const)('fails %s when half the pages lack the field', async (name, missing) => {
  const [floor] = PLAUSIBLE_LISTING_COUNT;
  const db = await seedMinimal(pagesRead(floor, (i) => (i % 2 ? missing : {})));

  const { byName, all } = await check(db);
  expect(byName[name]!.passed).toBe(false);
  expect(byName[name]!.severity).toBe('error');
  expect(report(all)).toBe(false);
});

it('passes bedrooms_coverage when rooms omit the bedroom line', async () => {
  const [floor] = PLAUSIBLE_LISTING_COUNT;
  const db = await seedMinimal(pagesRead(floor, (i) => (i % 4 === 0 ? { bedrooms: null } : {})));

  const { byName } = await check(db);
  expect(byName['bedrooms_coverage']!.passed).toBe(true);
});

it('fails bedrooms_coverage when bedroom lines go missing', async () => {
  const [floor] = PLAUSIBLE_LISTING_COUNT;
  const db = await seedMinimal(pagesRead(floor, (i) => (i % 4 === 0 ? {} : { bedrooms: null })));

  const { byName } = await check(db);
  expect(byName['bedrooms_coverage']!.passed).toBe(false);
});

it('skips the page field checks when no page was ever read', async () => {
  const db = await seedMinimal();

  const { byName } = await check(db);
  for (const name of PAGE_FIELD_CHECKS) expect(byName[name], name).toBeUndefined();
});

it('fails photo_coverage when this run’s pages yield no photos', async () => {
  const db = await seedMinimal();
  const pageStats = { ...emptyPageStats(), attempted: 100, withExactFlag: 100, withPhotos: 10 };

  const all = await runChecks(db, DAY, {
    pageStats,
    quoteStats: { attempted: 0, failed: 0, priced: 0 },
    searchResult: { listings: [], queries: 9, unresolved: [] },
    coverage: { boxes: 6, seen: 100, missedIds: [] },
  });
  const photos = all.find((result) => result.name === 'photo_coverage')!;
  expect(photos.passed).toBe(false);
  expect(photos.severity).toBe('error');
  expect(photos.detail).toContain('10/100');
});

it('passes the price quote checks when quotes are priced', async () => {
  const db = await seedMinimal();

  const { byName } = await check(db, { quoteStats: { attempted: 100, failed: 2, priced: 95 } });
  expect(byName['price_quote_failure_rate']!.passed).toBe(true);
  expect(byName['price_quote_priced']!.passed).toBe(true);
});

it('fails price_quote_failure_rate when quote requests fail', async () => {
  const db = await seedMinimal();

  const { byName, all } = await check(db, { quoteStats: { attempted: 100, failed: 60, priced: 40 } });
  expect(byName['price_quote_failure_rate']!.passed).toBe(false);
  expect(report(all)).toBe(false);
});

it('fails price_quote_priced when quotes come back without a price', async () => {
  const db = await seedMinimal();

  const { byName, all } = await check(db, { quoteStats: { attempted: 100, failed: 0, priced: 10 } });
  expect(byName['price_quote_priced']!.passed).toBe(false);
  expect(byName['price_quote_priced']!.detail).toContain('10/100');
  expect(report(all)).toBe(false);
});

it('skips the price quote checks when nothing was quoted', async () => {
  const db = await seedMinimal();

  const { byName } = await check(db);
  expect(byName['price_quote_failure_rate']).toBeUndefined();
});

it('passes first_review_failure_rate when few first-review fetches failed', async () => {
  const db = await seedMinimal([], { attempted: 100, failed: 2 });

  const { byName } = await check(db);
  expect(byName['first_review_failure_rate']!.passed).toBe(true);
});

it('warns without failing the run when many first-review fetches failed', async () => {
  const db = await seedMinimal([], { attempted: 100, failed: 90 });

  const { byName, all } = await check(db);
  expect(byName['first_review_failure_rate']!.passed).toBe(false);
  expect(byName['first_review_failure_rate']!.severity).toBe('warn');
  expect(byName['first_review_failure_rate']!.detail).toContain('90/100');
  expect(report(all)).toBe(true);
});

it('skips first_review_failure_rate on a run with nothing to resolve', async () => {
  const db = await seedMinimal();

  const { byName } = await check(db);
  expect(byName['first_review_failure_rate']).toBeUndefined();
});

/** Every seeded listing's page read, each under its own host, `withCard` of them with a card. */
function pagesWithCards(withCard: number): ListingPage[] {
  const [floor] = PLAUSIBLE_LISTING_COUNT;
  return pagesRead(floor).map((page, i) => ({
    ...page,
    hostCard:
      i < withCard
        ? { hostId: page.hostId, name: 'Rachel', about: null, timeAsHostYears: 9, timeAsHostMonths: 7 }
        : null,
  }));
}

it('passes the host profile checks when every host card was read', async () => {
  const [floor] = PLAUSIBLE_LISTING_COUNT;
  const db = await seedMinimal(pagesWithCards(floor));

  const { byName } = await check(db);
  expect(byName['host_profile_failure_rate']!.passed).toBe(true);
  expect(byName['host_profile_coverage']!.passed).toBe(true);
  expect(byName['host_start_date_stable']!.passed).toBe(true);
});

it('warns, without failing the run, when host cards stop being read', async () => {
  const db = await seedMinimal(pagesWithCards(10));

  const { byName, all } = await check(db);
  for (const name of ['host_profile_failure_rate', 'host_profile_coverage']) {
    expect(byName[name]!.passed).toBe(false);
    expect(byName[name]!.severity).toBe('warn');
  }
  expect(report(all)).toBe(true);
});

it('warns when a host’s start date moves', async () => {
  const [floor] = PLAUSIBLE_LISTING_COUNT;
  const db = await seedMinimal(pagesWithCards(floor));
  // An earlier reading a year off from today's.
  await db.run(
    'INSERT INTO airbnb_host_observations VALUES (1000, CAST(? AS DATE) - 1, true, \'Rachel\', NULL, 8, 7)',
    [DAY],
  );

  const { byName } = await check(db);
  expect(byName['host_start_date_stable']!.passed).toBe(false);
  expect(byName['host_start_date_stable']!.severity).toBe('warn');
  expect(byName['host_start_date_stable']!.detail).toContain('1000');
});
