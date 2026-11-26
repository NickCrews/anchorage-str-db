/** The `jitter_fits` macro agrees with `jitterFits`. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jitterFits } from '@anchorage-str-db/utils/jitter';
import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '../src/connect.ts';
import type { Database } from '../src/database.ts';

const temporary: string[] = [];
const open: Database[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('jitter_fits', () => {
  it('matches jitterFits across offsets and tolerances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchorage-str-jitter-'));
    temporary.push(dir);
    const db = await connect(join(dir, 't.duckdb'));
    open.push(db);

    const pin = { lat: 61.2, lng: -149.9 };
    const offsets = [0, 0.0001, 0.00025, 0.0008, 0.00119, 0.0013, 0.0016];
    const cases = offsets.flatMap((dLat) =>
      offsets.flatMap((dLng) => [0, 20].map((tolerance) => ({ dLat, dLng: -dLng, tolerance }))),
    );
    for (const { dLat, dLng, tolerance } of cases) {
      const point = { lat: pin.lat + dLat, lng: pin.lng + dLng };
      const [row] = await db.rows<{ fits: boolean }>(
        `SELECT jitter_fits(${pin.lat}, ${pin.lng}, ${point.lat}, ${point.lng}, tolerance_m := ${tolerance}) AS fits`,
      );
      expect(row?.fits, JSON.stringify({ dLat, dLng, tolerance })).toBe(jitterFits(pin, point, tolerance));
    }
  });
});
