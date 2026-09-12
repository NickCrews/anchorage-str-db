import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { report, runChecks, type CheckResult } from '../src/checks.ts';
import { calendarResultFor } from './helpers.ts';
import * as config from '../src/config.ts';
import type { IsoDate } from '../src/dates.ts';
import type { Database } from '../src/db.ts';
import { emptyAudit, PriceBand, type CoverageAudit, type SearchResult } from '../src/search.ts';
import {
  connect,
  emptyPageStats,
  logRun,
  mergeCalendar,
  recordObservations,
} from '../src/store.ts';
import { makeListing } from './fixtures.ts';

const DAY: IsoDate = '2026-08-18';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Enough rows for listing_count_plausible and observations_written_today to pass. */
async function seedMinimal(): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-'));
  temporary.push(dir);
  const db = await connect(join(dir, 't.duckdb'));
  open.push(db);

  const [floor] = config.PLAUSIBLE_LISTING_COUNT;
  const listings = [...Array(floor).keys()].map((i) => makeListing(i, `Cabin ${i}`));
  await recordObservations(db, DAY, listings);
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
    errorSummary: null,
  });
  return db;
}

/** Run the checks with healthy in-memory pass stats unless overridden. */
async function check(
  db: Database,
  overrides: { searchResult?: SearchResult; coverage?: CoverageAudit } = {},
): Promise<{ byName: Record<string, CheckResult>; all: CheckResult[] }> {
  const all = await runChecks(db, DAY, {
    pageStats: emptyPageStats(),
    searchResult: overrides.searchResult ?? { listings: [], queries: 9, unresolved: [] },
    coverage: overrides.coverage ?? { boxes: 6, seen: 100, missedIds: [] },
  });
  return { byName: Object.fromEntries(all.map((result) => [result.name, result])), all };
}

it('passes no_backdated_calendar_rows on clean data', async () => {
  const db = await seedMinimal();
  await mergeCalendar(db, DAY, [calendarResultFor('0', '2026-08-18', true, 1, 100)]);

  const { byName } = await check(db);
  expect(byName['no_backdated_calendar_rows']!.passed).toBe(true);
});

it('fails no_backdated_calendar_rows for a night before its valid_from', async () => {
  const db = await seedMinimal();
  // Bypasses `toNights`, which normally drops such nights.
  await mergeCalendar(db, DAY, [calendarResultFor('0', '2026-08-01', false, 1, null)]);

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
