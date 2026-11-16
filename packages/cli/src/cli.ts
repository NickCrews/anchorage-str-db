#!/usr/bin/env node
/** `anchorage-str-db scrape <airbnb|licenses|parcels> [--db PATH] [--date YYYY-MM-DD] [-v] [source options]` */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runDaily } from '@anchorage-str-db/airbnb-scraper/pipeline';
import { runScan } from '@anchorage-str-db/licenses-scraper/scan';
import { MAX_READS_PER_SCAN } from '@anchorage-str-db/licenses-scraper/select';
import { ANCHORAGE_PROPERTY_URL, runImport } from '@anchorage-str-db/parcels-scraper/import';
import { parseIsoDate, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log, setLevel } from '@anchorage-str-db/utils/log';

/** The repo's `data/anchorage_str.duckdb`, from any working directory. */
const DEFAULT_DB_PATH = fileURLToPath(
  new URL('../../../data/anchorage_str.duckdb', import.meta.url),
);

export const SOURCES = ['airbnb', 'licenses', 'parcels'] as const;
export type Source = (typeof SOURCES)[number];

export interface ScrapeOptions {
  dbPath: string;
  /** The date the run is recorded under; today, UTC, when absent. */
  date?: IsoDate;
  /** licenses only: license pages to read at most. */
  maxReads?: number;
  /** parcels only: anchorage-property's database, a URL or a local path. */
  sourceUrl?: string;
}

/** Each source's run. Resolves to true iff its error-severity checks passed. */
export type Scrapers = Record<Source, (options: ScrapeOptions) => Promise<boolean>>;

const SCRAPERS: Scrapers = {
  airbnb: ({ dbPath, date }) => runDaily({ dbPath, ...(date === undefined ? {} : { scrapeDate: date }) }),
  licenses: ({ dbPath, date, maxReads }) =>
    runScan({
      dbPath,
      ...(date === undefined ? {} : { scrapeDate: date }),
      ...(maxReads === undefined ? {} : { maxReads }),
    }),
  parcels: ({ dbPath, date, sourceUrl }) =>
    runImport({
      dbPath,
      ...(date === undefined ? {} : { importDate: date }),
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
    }),
};

const USAGE = `usage: anchorage-str-db scrape <source> [options]

sources:
  airbnb      search Anchorage, fetch each listing's calendar and page, merge,
              run quality checks
  licenses    find the newest license id, read a batch of CityView license
              pages, geocode new addresses, write them, run quality checks
  parcels     copy anchorage-property's current parcels into property_parcels,
              replacing them, if the source passes its checks

options:
  --db PATH       path to the DuckDB file (default: ${DEFAULT_DB_PATH})
  --date DATE     date to record this run under (default: today, UTC)
  -v, --verbose   log every check, not just failures
  -h, --help      show this message

licenses options:
  --max-reads N   license pages to read at most (default: ${MAX_READS_PER_SCAN})

parcels options:
  --source URL    anchorage-property's database, a URL or a local path
                  (default: ${ANCHORAGE_PROPERTY_URL})
`;

/** Options that only one source takes. */
const SOURCE_OPTIONS = { 'max-reads': 'licenses', source: 'parcels' } as const satisfies Record<string, Source>;

function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}`);
  return 2;
}

export async function main(argv: string[], scrapers: Scrapers = SCRAPERS): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        db: { type: 'string', default: DEFAULT_DB_PATH },
        date: { type: 'string' },
        'max-reads': { type: 'string' },
        source: { type: 'string' },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    return usageError(describeError(err));
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  setLevel(values.verbose ? 'debug' : 'info');

  const [command, source, ...extra] = positionals;
  if (command !== 'scrape') {
    return usageError(command === undefined ? 'no command given' : `unknown command: ${command}`);
  }
  if (!SOURCES.includes(source as Source)) {
    return usageError(source === undefined ? 'no source given' : `unknown source: ${source}`);
  }
  if (extra.length > 0) return usageError(`unexpected argument: ${extra[0]}`);
  const chosen = source as Source;

  // Validated before the run so a bad option is a usage error, not a failed run.
  for (const [option, owner] of Object.entries(SOURCE_OPTIONS)) {
    if (values[option as keyof typeof SOURCE_OPTIONS] !== undefined && owner !== chosen) {
      return usageError(`--${option} applies only to ${owner}`);
    }
  }
  let date;
  try {
    date = values.date === undefined ? undefined : parseIsoDate(values.date);
  } catch (err) {
    return usageError(`--date: ${describeError(err)}`);
  }
  const maxReads = values['max-reads'] === undefined ? undefined : Number(values['max-reads']);
  if (maxReads !== undefined && !(Number.isInteger(maxReads) && maxReads >= 0)) {
    return usageError(`--max-reads: not a whole number: ${values['max-reads']}`);
  }

  const dbPath = values.db;
  await mkdir(dirname(dbPath), { recursive: true });

  try {
    const ok = await scrapers[chosen]({
      dbPath,
      ...(date === undefined ? {} : { date }),
      ...(maxReads === undefined ? {} : { maxReads }),
      ...(values.source === undefined ? {} : { sourceUrl: values.source }),
    });
    return ok ? 0 : 1;
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }
}

// True only when run directly, so importing this file does not start a run.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
