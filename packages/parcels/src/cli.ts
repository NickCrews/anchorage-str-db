#!/usr/bin/env node
/** `anchorage-str-db-parcels [--db PATH] [--date YYYY-MM-DD] [--source URL] [-v] import` */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parseIsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log, setLevel } from '@anchorage-str-db/utils/log';

import { ANCHORAGE_PROPERTY_URL, runImport } from './import.ts';

/** The repo's `data/anchorage_str.duckdb`, from any working directory. */
const DEFAULT_DB_PATH = fileURLToPath(
  new URL('../../../data/anchorage_str.duckdb', import.meta.url),
);

const USAGE = `usage: anchorage-str-db-parcels [options] import

  import    copy anchorage-property's current parcels into property_parcels,
            replacing them, if the source passes its checks

options:
  --db PATH       path to the DuckDB file (default: ${DEFAULT_DB_PATH})
  --date DATE     import_date to record this import under (default: today, UTC)
  --source URL    anchorage-property's database, a URL or a local path
                  (default: ${ANCHORAGE_PROPERTY_URL})
  -v, --verbose   log every check, not just failures
  -h, --help      show this message
`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        db: { type: 'string', default: DEFAULT_DB_PATH },
        date: { type: 'string' },
        source: { type: 'string', default: ANCHORAGE_PROPERTY_URL },
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
  if (command !== 'import') {
    process.stderr.write(
      `${command === undefined ? 'no command given' : `unknown command: ${command}`}\n\n${USAGE}`,
    );
    return 2;
  }

  // Validated before the import so a bad option is a usage error, not a failed import.
  let importDate;
  try {
    importDate = values.date === undefined ? undefined : parseIsoDate(values.date);
  } catch (err) {
    process.stderr.write(`--date: ${describeError(err)}\n\n${USAGE}`);
    return 2;
  }

  const dbPath = values.db;
  await mkdir(dirname(dbPath), { recursive: true });

  try {
    const ok = await runImport({
      dbPath,
      sourceUrl: values.source,
      ...(importDate === undefined ? {} : { importDate }),
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
