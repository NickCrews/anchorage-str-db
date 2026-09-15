/**
 * Places on both sides of the Municipality's boundary. The listings outside
 * it are the ones nearest the line in Hope, Palmer and Wasilla on
 * 2026-09-14. The two edge listings are in the Municipality, but their
 * blurred positions fall outside the community councils `municipality.sql`
 * starts from.
 */

import { describe, expect, it } from 'vitest';

import {
  boundingBox,
  inMunicipality,
  type PolygonCollection,
} from '../../src/muni_geography/index.ts';

describe('inMunicipality', () => {
  it.each([
    ['downtown Anchorage', 61.2176, -149.8997],
    ['Eagle River', 61.3214, -149.5686],
    ['Girdwood', 60.9584, -149.1178],
    ['Indian', 60.995, -149.497],
    ['Portage', 60.8375, -148.98],
    ['a blurred listing near Eklutna, 232 m outside the councils', 61.41, -149.14918],
    ['a blurred listing near Glen Alps, 53 m outside the councils', 61.10909, -149.70935],
  ])('includes %s', (_, lat, lng) => {
    expect(inMunicipality(lat, lng)).toBe(true);
  });

  it.each([
    ['a listing in Hope', 60.92238, -149.6167],
    ['a listing in Palmer', 61.49116, -149.07731],
    ['a listing across Knik Arm, captioned Wasilla', 61.34124, -149.91071],
    ['Whittier', 60.7736, -148.6834],
  ])('excludes %s', (_, lat, lng) => {
    expect(inMunicipality(lat, lng)).toBe(false);
  });
});

describe('boundingBox', () => {
  it('spans every ring of every feature', () => {
    const collection: PolygonCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [[[-150, 61], [-149, 61], [-149, 61.5], [-150, 61]]],
          },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[[[-148, 60], [-147.5, 60], [-147.5, 60.2], [-148, 60]]]],
          },
        },
      ],
    };
    expect(boundingBox(collection)).toEqual({ swLat: 60, swLng: -150, neLat: 61.5, neLng: -147.5 });
  });

  it('throws for a collection with no coordinates', () => {
    expect(() => boundingBox({ type: 'FeatureCollection', features: [] })).toThrow();
  });
});
