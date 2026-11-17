#!/usr/bin/env node
/**
 * `pnpm airbnb:check`: call each Airbnb endpoint once and report which broke
 * and how (see `src/probe.ts`). Exits 1 if any endpoint failed.
 */

import { log } from '@anchorage-str-db/utils/log';

import { ENDPOINTS, probeAirbnb } from '../src/probe.ts';

const results = await probeAirbnb();
for (const result of results) {
  if (result.problem === null) log.info(`ok      ${result.endpoint}: ${result.detail}`);
  else log.error(`FAILED  ${result.endpoint} (${result.problem}): ${result.detail}`);
}
const probed = new Set(results.map((result) => result.endpoint));
for (const endpoint of ENDPOINTS) {
  if (!probed.has(endpoint)) log.warn(`skipped ${endpoint}: an earlier endpoint failed`);
}
const failed = results.filter((result) => result.problem !== null);
process.exitCode = failed.length > 0 || probed.size < ENDPOINTS.length ? 1 : 0;
