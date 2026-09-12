/**
 * The bounding box is the scrape's entire definition of "Anchorage".
 *
 * Nothing downstream can tell a listing that does not exist from one the
 * search was never asked about, so the box's coverage of the municipality is
 * not something a data-quality check can verify after the fact — it has to
 * be asserted against an independent description of where Anchorage is.
 */

import { describe, expect, it } from 'vitest';

import { BBOX, MUNICIPALITY_EXTENT } from '../src/config.ts';

describe('the Anchorage bounding box', () => {
  it('contains the whole municipality', () => {
    // A box that clips any edge undercounts silently: listings outside it
    // are never asked about.
    expect(BBOX.swLat, 'box clips the south of the municipality').toBeLessThan(
      MUNICIPALITY_EXTENT.swLat,
    );
    expect(BBOX.neLat, 'box clips the north of the municipality').toBeGreaterThan(
      MUNICIPALITY_EXTENT.neLat,
    );
    expect(BBOX.swLng, 'box clips the west of the municipality').toBeLessThan(
      MUNICIPALITY_EXTENT.swLng,
    );
    expect(BBOX.neLng, 'box clips the east of the municipality').toBeGreaterThan(
      MUNICIPALITY_EXTENT.neLng,
    );
  });

  it('covers Girdwood', () => {
    // Girdwood is ~40 miles from downtown but inside the municipality, and
    // is dense with STRs. It sits far enough from the Bowl that a box drawn
    // around the city proper misses it entirely.
    const [lat, lng] = [60.9584, -149.1178];
    expect(lat).toBeGreaterThanOrEqual(BBOX.swLat);
    expect(lat).toBeLessThanOrEqual(BBOX.neLat);
    expect(lng).toBeGreaterThanOrEqual(BBOX.swLng);
    expect(lng).toBeLessThanOrEqual(BBOX.neLng);
  });

  it('is not absurdly larger than the municipality', () => {
    // Padding is deliberate, but a box several times too big wastes the
    // search budget on the Chugach and Cook Inlet and would hide a mistake
    // like swapped coordinates.
    const area = (box: typeof BBOX): number =>
      (box.neLat - box.swLat) * (box.neLng - box.swLng);
    expect(area(BBOX)).toBeLessThan(area(MUNICIPALITY_EXTENT) * 1.5);
  });
});
