#!/usr/bin/env node
/**
 * `pnpm airbnb:capture [--out DIR] [--write]`: open Airbnb's search and a
 * listing page in a headless browser, and compare each GraphQL query's
 * current persisted-query id with the one the client sends.
 *
 * Ids are read two ways: from every loaded script, as
 * `name:'<operation>',type:'query',operationId:'<id>'`, and from the
 * `/api/v3/<operation>/<id>` requests the pages make. Each request's
 * variables and response are saved to `DIR` (default `airbnb-capture/`), to
 * compare with what the client sends when a query's variables changed.
 *
 * `--write` replaces each stale `OPERATION_ID` in `src/api/` with the current
 * one. That fixes a compatible change; run `pnpm airbnb:check` afterwards to
 * find out whether the change was compatible.
 *
 * Exits 1 if any id differs or a query was not found, which usually means
 * Airbnb renamed it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium, type Page } from 'playwright';

import { OPERATION_ID as CALENDAR_ID } from '../src/api/calendar.ts';
import { OPERATION_ID as PRICE_QUOTE_ID } from '../src/api/priceQuote.ts';
import { OPERATION_ID as REVIEWS_ID } from '../src/api/reviews.ts';
import { OPERATION_ID as SEARCH_ID } from '../src/api/search.ts';

/** Each query the client sends, its source file, and the id it sends. */
const QUERIES = [
  { operation: 'StaysSearch', file: 'search.ts', id: SEARCH_ID },
  { operation: 'PdpAvailabilityCalendarV2Query', file: 'calendar.ts', id: CALENDAR_ID },
  { operation: 'StaysPdpBookItQuery', file: 'priceQuote.ts', id: PRICE_QUOTE_ID },
  { operation: 'StaysPdpReviewsQuery', file: 'reviews.ts', id: REVIEWS_ID },
] as const;

const API_DIR = fileURLToPath(new URL('../src/api/', import.meta.url));

const OPERATION_RE = /name:\s*['"](\w+)['"],\s*type:\s*['"]query['"],\s*operationId:\s*['"]([0-9a-f]{64})['"]/g;
const API_PATH_RE = /\/api\/v3\/(\w+)\/([0-9a-f]{64})/;

interface Captured {
  operation: string;
  id: string;
  method: string;
  url: string;
  variables: unknown;
  status: number;
  response: unknown;
}

function variablesOf(url: URL, postData: string | null): unknown {
  if (postData) {
    try {
      return (JSON.parse(postData) as { variables?: unknown }).variables ?? null;
    } catch {
      return null;
    }
  }
  const raw = url.searchParams.get('variables');
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

/** An ISO date `days` from today, UTC. */
function isoDaysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'airbnb-capture' },
      write: { type: 'boolean', default: false },
    },
  });

  const fromScripts = new Map<string, Set<string>>();
  const captured: Captured[] = [];
  const pending: Array<Promise<void>> = [];

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Anchorage' });
    const page = await context.newPage();
    page.on('response', (response) => {
      const url = new URL(response.url());
      pending.push(
        (async () => {
          const type = response.request().resourceType();
          if (type === 'script') {
            const text = await response.text().catch(() => '');
            for (const match of text.matchAll(OPERATION_RE)) {
              const ids = fromScripts.get(match[1]!) ?? new Set<string>();
              ids.add(match[2]!);
              fromScripts.set(match[1]!, ids);
            }
            return;
          }
          const api = API_PATH_RE.exec(url.pathname);
          if (!api) return;
          const body = await response.text().catch(() => '');
          let parsed: unknown = body;
          try {
            parsed = JSON.parse(body);
          } catch {
            // Keep the text.
          }
          captured.push({
            operation: api[1]!,
            id: api[2]!,
            method: response.request().method(),
            url: response.url(),
            variables: variablesOf(url, response.request().postData()),
            status: response.status(),
            response: parsed,
          });
        })(),
      );
    });

    await page.goto('https://www.airbnb.com/s/Anchorage--AK/homes', { waitUntil: 'domcontentloaded' });
    await settle(page);
    const href = await page.locator('a[href*="/rooms/"]').first().getAttribute('href');
    const listingId = href ? /\/rooms\/(\d+)/.exec(href)?.[1] : undefined;
    if (!listingId) throw new Error('no listing link on the search page');

    // Dates far enough out that most listings are free, so the page prices a stay.
    const checkIn = isoDaysAhead(45);
    const checkOut = isoDaysAhead(48);
    await page.goto(`https://www.airbnb.com/rooms/${listingId}?check_in=${checkIn}&check_out=${checkOut}&adults=1`, {
      waitUntil: 'domcontentloaded',
    });
    await settle(page);
    // The calendar and reviews queries run as their sections scroll into view.
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(500);
    }
    await settle(page);
    await Promise.all(pending);
  } finally {
    await browser.close();
  }

  await mkdir(values.out, { recursive: true });
  for (const request of captured) {
    await writeFile(join(values.out, `${request.operation}.json`), `${JSON.stringify(request, null, 2)}\n`);
  }

  let stale = 0;
  for (const query of QUERIES) {
    const ids = new Set([
      ...(fromScripts.get(query.operation) ?? []),
      ...captured.filter((request) => request.operation === query.operation).map((request) => request.id),
    ]);
    const label = query.operation.padEnd(32);
    if (ids.size === 0) {
      stale++;
      process.stdout.write(`${label} NOT FOUND (renamed or no longer loaded); client sends ${query.id}\n`);
      continue;
    }
    if (ids.has(query.id)) {
      process.stdout.write(`${label} current  ${query.id}\n`);
      continue;
    }
    stale++;
    const current = [...ids];
    process.stdout.write(`${label} CHANGED  ${query.id} -> ${current.join(' | ')}\n`);
    if (values.write && current.length === 1) {
      const path = join(API_DIR, query.file);
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(query.id, current[0]!));
      process.stdout.write(`${' '.repeat(33)}wrote src/api/${query.file}\n`);
    }
  }

  const known = new Set<string>(QUERIES.map((query) => query.operation));
  const others = [...new Set(captured.map((request) => request.operation))].filter((op) => !known.has(op));
  process.stdout.write(`\nother queries the pages ran: ${others.sort().join(', ') || 'none'}\n`);
  process.stdout.write(`requests saved to ${values.out}/\n`);
  return stale > 0 ? 1 : 0;
}

process.exitCode = await main();
