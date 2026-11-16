#!/usr/bin/env node
/** `anchorage-str-db [--db PATH] [--date YYYY-MM-DD] [-v] scrape` */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parseIsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log, setLevel } from '@anchorage-str-db/utils/log';

import { runScrape } from './pipeline.ts';

/** The repo's `data/anchorage_str.duckdb`, from any working directory. */
const DEFAULT_DB_PATH = fileURLToPath(
  new URL('../../../data/anchorage_str.duckdb', import.meta.url),
);

const USAGE = `usage: anchorage-str-db [options] scrape

  scrape    search Anchorage, fetch each listing's calendar and page, merge,
            run quality checks

options:
  --db PATH     path to the DuckDB file (default: ${DEFAULT_DB_PATH})
  --date DATE   scrape_date to record this run under (default: today, UTC)
  -v, --verbose log every check, not just failures
  -h, --help    show this message
`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        db: { type: 'string', default: DEFAULT_DB_PATH },
        date: { type: 'string' },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  setLevel(values.verbose ? 'debug' : 'info');

  const command = positionals[0];
  if (command !== 'scrape') {
    process.stderr.write(
      `${command === undefined ? 'no command given' : `unknown command: ${command}`}\n\n${USAGE}`,
    );
    return 2;
  }

  // Validated before the run so a bad `--date` is a usage error, not a failed run.
  let scrapeDate;
  try {
    scrapeDate = values.date === undefined ? undefined : parseIsoDate(values.date);
  } catch (err) {
    process.stderr.write(`--date: ${describeError(err)}\n\n${USAGE}`);
    return 2;
  }

  const dbPath = values.db;
  await mkdir(dirname(dbPath), { recursive: true });

  try {
    const ok = await runScrape({ dbPath, ...(scrapeDate === undefined ? {} : { scrapeDate }) });
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
