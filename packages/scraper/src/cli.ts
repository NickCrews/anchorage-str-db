#!/usr/bin/env node
/**
 * `anchorage-str-db [--db PATH] [--date YYYY-MM-DD] [-v] daily`
 *
 * One subcommand, because there is one pipeline. Argument parsing is Node's
 * own `util.parseArgs` — there is nothing here a dependency would do better.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_DB_PATH } from './config.ts';
import { parseIsoDate } from './dates.ts';
import { describeError, log, setLevel } from './log.ts';
import { runDaily } from './pipeline.ts';

const USAGE = `usage: anchorage-str-db [options] daily

  daily   search Anchorage, fetch each listing's calendar and page, merge,
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
  if (command !== 'daily') {
    process.stderr.write(
      `${command === undefined ? 'no command given' : `unknown command: ${command}`}\n\n${USAGE}`,
    );
    return 2;
  }

  // Validated here rather than inside the run: a malformed `--date` is a
  // usage error, not a failed scrape, and should not be reported as one.
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
    const ok = await runDaily({ dbPath, ...(scrapeDate === undefined ? {} : { scrapeDate }) });
    return ok ? 0 : 1;
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }
}

// `import.meta.main` is true only when this file is what Node was asked to
// run, so importing the CLI from a test does not launch a scrape.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
