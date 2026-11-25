/**
 * Argument parsing and dispatch, with every source's run replaced by a
 * recorder. No network and no database.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, type ScrapeOptions, type Scrapers, type Source } from '../src/cli.ts';

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-cli-'));
  temporary.push(dir);
  return join(dir, 'nested', 'test.duckdb');
}

/** Scrapers that record their calls and resolve to `ok`. */
function recorders(ok = true): { scrapers: Scrapers; calls: [Source, ScrapeOptions][] } {
  const calls: [Source, ScrapeOptions][] = [];
  const recorder = (source: Source) => async (options: ScrapeOptions) => {
    calls.push([source, options]);
    return ok;
  };
  return {
    calls,
    scrapers: { airbnb: recorder('airbnb'), licenses: recorder('licenses'), parcels: recorder('parcels') },
  };
}

describe('main', () => {
  it('runs the named source with the shared options', async () => {
    const { scrapers, calls } = recorders();
    const db = await dbPath();

    expect(await main(['scrape', 'airbnb', '--db', db, '--date', '2026-11-14'], scrapers)).toBe(0);
    expect(calls).toEqual([['airbnb', { dbPath: db, scrapeDate: '2026-11-14' }]]);
  });

  it("passes each source's own option", async () => {
    const { scrapers, calls } = recorders();
    const db = await dbPath();

    expect(
      await main(['scrape', 'licenses', '--db', db, '--read-budget-seconds', '60', '--geocode-budget-seconds', '0'], scrapers),
    ).toBe(0);
    expect(await main(['scrape', 'parcels', '--db', db, '--source', './p.duckdb'], scrapers)).toBe(0);
    expect(calls).toEqual([
      ['licenses', { dbPath: db, readBudgetMs: 60_000, geocodeBudgetMs: 0 }],
      ['parcels', { dbPath: db, sourceUrl: './p.duckdb' }],
    ]);
  });

  it('exits 1 when the run fails its checks', async () => {
    const { scrapers } = recorders(false);
    expect(await main(['scrape', 'parcels', '--db', await dbPath()], scrapers)).toBe(1);
  });

  it.each([
    [[]],
    [['scan']],
    [['scrape']],
    [['scrape', 'vrbo']],
    [['scrape', 'airbnb', 'licenses']],
    [['scrape', 'airbnb', '--read-budget-seconds', '60']],
    [['scrape', 'licenses', '--source', './p.duckdb']],
    [['scrape', 'licenses', '--read-budget-seconds', '-1']],
    [['scrape', 'licenses', '--geocode-budget-seconds', '1.5']],
    [['scrape', 'parcels', '--date', '14/11/2026']],
  ])('rejects %j as a usage error', async (argv) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { scrapers, calls } = recorders();

    expect(await main([...argv, '--db', await dbPath()], scrapers)).toBe(2);
    expect(calls).toEqual([]);
  });
});
