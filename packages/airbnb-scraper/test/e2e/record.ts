/**
 * Re-records `run.json.gz`, the live exchanges `scrape.test.ts` replays: a
 * scrape of `E2E_BOX` into a throwaway database.
 *
 *     node packages/airbnb-scraper/test/e2e/record.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { createClient, type Transport } from 'airbnb-dlp';
import { recordingTransport } from 'airbnb-dlp/testing';
import { Impit } from 'impit';

import { todayUtc } from '@anchorage-str-db/utils/dates';

import { scrapeAirbnb } from '../../src/scrape.ts';
import { E2E_BOX, type E2eRecording } from './box.ts';

function impitTransport(): Transport {
  const impit = new Impit({ browser: 'chrome' });
  return async (request, signal) => {
    const response = await impit.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: request.body }),
      signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}

const transport = recordingTransport(impitTransport());
const startedAtMs = Date.now();
const scrapeDate = todayUtc();
const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-e2e-'));
try {
  await scrapeAirbnb({
    dbPath: join(dir, 'record.duckdb'),
    scrapeDate,
    client: createClient({ transport }),
    searchBox: E2E_BOX,
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

const recording: E2eRecording = {
  scrapeDate,
  startedAtMs,
  recordings: transport
    .recordings()
    .map(({ recordedAt, request, response }) => ({ recordedAt, request: { ...request, headers: {} }, response })),
};
const out = new URL('./run.json.gz', import.meta.url);
await writeFile(out, gzipSync(JSON.stringify(recording)));
console.log(`${recording.recordings.length} exchanges written to ${out.pathname}`);
