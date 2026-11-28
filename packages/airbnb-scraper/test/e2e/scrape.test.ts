/**
 * The whole scrape, from airbnb-dlp's requests to the checks, replaying a
 * recorded live run of `E2E_BOX` (see `record.ts`). Some requests in the
 * recording failed in transit, and replay fails them the same way.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createClient, type Clock } from 'airbnb-dlp';
import { replayTransport } from 'airbnb-dlp/testing';
import { connect } from '@anchorage-str-db/db/connect';
import type { Database } from '@anchorage-str-db/db/database';
import type { CheckResult } from '@anchorage-str-db/utils/checks';

import { scrapeAndCheck } from '../../src/scrape.ts';
import { E2E_BOX, type E2eRecording } from './box.ts';

/** The system clock, moved back to when the recording started. */
function clockAt(startMs: number): Clock {
  const offset = Date.now() - startMs;
  return {
    now: () => Date.now() - offset,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
  };
}

let dir: string;
let db: Database;
let run: E2eRecording;
let checks: CheckResult[];

beforeAll(async () => {
  run = JSON.parse(gunzipSync(await readFile(new URL('./run.json.gz', import.meta.url))).toString());
  dir = await mkdtemp(join(tmpdir(), 'anchorage-str-e2e-'));
  const dbPath = join(dir, 'e2e.duckdb');
  checks = await scrapeAndCheck({
    dbPath,
    scrapeDate: run.scrapeDate,
    client: createClient({ transport: replayTransport(run.recordings), clock: clockAt(run.startedAtMs) }),
    searchBox: E2E_BOX,
  });
  db = await connect(dbPath);
}, 120_000);

afterAll(async () => {
  db?.close();
  await rm(dir, { recursive: true, force: true });
});

it('stores every listing search found, with its page', async () => {
  const rows = await db.rows(
    'SELECT count(*)::INT AS n, count(*) FILTER (WHERE page_fetch_ok)::INT AS pages, ' +
      "count(*) FILTER (WHERE listing_type IN ('entire_home', 'private_room', 'shared_room', 'hotel_room'))::INT AS typed, " +
      'count(property_type)::INT AS property_typed, count(location_subtitle)::INT AS subtitled, ' +
      "count(*) FILTER (WHERE registration_id SIMILAR TO 'STR[0-9]{6,}')::INT AS registered " +
      'FROM airbnb_listing_observations',
  );
  expect(rows).toEqual([
    { n: 12, pages: 12, typed: 12, property_typed: 12, subtitled: 12, registered: 12 },
  ]);
});

it('stores the hosts, calendars, quotes and first reviews', async () => {
  const counts = await db.rows(
    `SELECT
       (SELECT count(*) FROM airbnb_host_observations WHERE profile_read_ok)::INT AS hosts,
       (SELECT count(DISTINCT listing_id) FROM airbnb_calendar_status)::INT AS calendars,
       (SELECT count(*) FROM airbnb_calendar_status WHERE night_date < valid_from)::INT AS backdated,
       (SELECT count(*) FROM airbnb_listing_observations WHERE quote_total > 0)::INT AS priced,
       (SELECT count(*) FROM airbnb_listing_first_reviews)::INT AS first_reviews`,
  );
  expect(counts).toEqual([{ hosts: 1, calendars: 11, backdated: 0, priced: 9, first_reviews: 11 }]);
});

it('passes every check except those that need the whole Municipality', () => {
  // 12 listings fall short of the plausible count, and no license scrape
  // wrote the registrations they cite.
  expect(checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
    'listing_count_plausible',
    'airbnb_registration_match',
  ]);
});
