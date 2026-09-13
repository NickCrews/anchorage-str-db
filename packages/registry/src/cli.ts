#!/usr/bin/env node
/** `anchorage-str-registry [--db PATH] [--service-url URL] refresh|probe` */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_DB_PATH, SERVICE_URL_ENV, serviceUrl } from './config.ts';
import { parseIsoDate } from './dates.ts';
import { describeError, log, setLevel } from './log.ts';
import { runRefresh } from './pipeline.ts';
import { probe } from './probe.ts';

const USAGE = `usage: anchorage-str-registry [options] refresh|probe

  refresh  read the whole registry layer, merge it into the database, run
           the quality checks
  probe    print what a layer calls itself, how its fields map, and a few
           records; writes nothing

options:
  --db PATH          path to the DuckDB file (default: ${DEFAULT_DB_PATH})
  --service-url URL  the ArcGIS layer, ending in a layer index; defaults to
                     $${SERVICE_URL_ENV}
  --date DATE        refresh_date to record this run under (default: today, UTC)
  -v, --verbose      log every check, not just failures
  -h, --help         show this message
`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        db: { type: 'string', default: DEFAULT_DB_PATH },
        'service-url': { type: 'string' },
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
  if (command !== 'refresh' && command !== 'probe') {
    process.stderr.write(
      `${command === undefined ? 'no command given' : `unknown command: ${command}`}\n\n${USAGE}`,
    );
    return 2;
  }

  // Both are usage errors, so they are resolved before anything runs rather
  // than failing a run halfway.
  let url;
  let refreshDate;
  try {
    // `probe <url>` also takes the layer as a positional, which is how it is
    // usually used: against a URL not yet worth putting in the environment.
    url = serviceUrl(values['service-url'] ?? positionals[1]);
    refreshDate = values.date === undefined ? undefined : parseIsoDate(values.date);
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n\n${USAGE}`);
    return 2;
  }

  try {
    if (command === 'probe') {
      await probe(url, (line) => process.stdout.write(`${line}\n`));
      return 0;
    }
    await mkdir(dirname(values.db), { recursive: true });
    const ok = await runRefresh({
      dbPath: values.db,
      serviceUrl: url,
      ...(refreshDate === undefined ? {} : { refreshDate }),
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
