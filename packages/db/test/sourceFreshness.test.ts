/** The `source_freshness` view over every source's run log, seeded directly. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '../src/connect.ts';
import type { Database } from '../src/database.ts';
import { airbnbScrapeRuns, muniLicenseRuns, propertyParcelImports } from '../src/schema.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDb(): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-freshness-'));
  temporary.push(dir);
  const db = await connect(join(dir, 't.duckdb'));
  open.push(db);
  return db;
}

const QUERY = `
  SELECT source, strftime(last_success_date, '%Y-%m-%d') AS date,
    strftime(last_success_finished_at, '%Y-%m-%d %H:%M') AS finished_at
  FROM source_freshness ORDER BY source`;

describe('source_freshness', () => {
  it('has a NULL row for every source before any run', async () => {
    const db = await freshDb();

    expect(await db.rows(QUERY)).toEqual([
      { source: 'airbnb', date: null, finished_at: null },
      { source: 'muni_licenses', date: null, finished_at: null },
      { source: 'property_parcels', date: null, finished_at: null },
    ]);
  });

  it("keeps each source's last good run while another source fails", async () => {
    const db = await freshDb();
    const run = (date: string, hour: string, errorSummary: string | null) => ({
      runStartedAt: `${date} ${hour}:00:00`,
      runFinishedAt: `${date} ${hour}:30:00`,
      errorSummary,
    });
    await db.orm.insert(airbnbScrapeRuns).values([
      { scrapeDate: '2026-11-07', ...run('2026-11-07', '12', null) },
      { scrapeDate: '2026-11-08', ...run('2026-11-08', '12', 'RateLimitedError') },
    ]);
    await db.orm.insert(muniLicenseRuns).values([
      { scrapeDate: '2026-11-07', ...run('2026-11-07', '08', null) },
      { scrapeDate: '2026-11-08', ...run('2026-11-08', '08', null) },
    ]);
    await db.orm.insert(propertyParcelImports).values([
      { importDate: '2026-11-08', ...run('2026-11-08', '16', null) },
    ]);

    expect(await db.rows(QUERY)).toEqual([
      { source: 'airbnb', date: '2026-11-07', finished_at: '2026-11-07 12:30' },
      { source: 'muni_licenses', date: '2026-11-08', finished_at: '2026-11-08 08:30' },
      { source: 'property_parcels', date: '2026-11-08', finished_at: '2026-11-08 16:30' },
    ]);
  });
});
