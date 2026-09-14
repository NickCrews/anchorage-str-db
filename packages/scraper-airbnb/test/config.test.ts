/**
 * The bounding box defines the scrape's scope. Listings outside it are never
 * searched, so no data-quality check can detect a box that is too small.
 */

import { describe, expect, it } from 'vitest';

import { BBOX, MUNICIPALITY_EXTENT } from '../src/config.ts';

describe('the Anchorage bounding box', () => {
  it('contains the whole municipality', () => {
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
    // Girdwood is in the municipality but ~40 miles from downtown.
    const [lat, lng] = [60.9584, -149.1178];
    expect(lat).toBeGreaterThanOrEqual(BBOX.swLat);
    expect(lat).toBeLessThanOrEqual(BBOX.neLat);
    expect(lng).toBeGreaterThanOrEqual(BBOX.swLng);
    expect(lng).toBeLessThanOrEqual(BBOX.neLng);
  });

  it('is less than 1.5x the area of the municipality', () => {
    // An oversized box wastes requests and can hide mistakes like swapped
    // coordinates.
    const area = (box: typeof BBOX): number =>
      (box.neLat - box.swLat) * (box.neLng - box.swLng);
    expect(area(BBOX)).toBeLessThan(area(MUNICIPALITY_EXTENT) * 1.5);
  });
});
