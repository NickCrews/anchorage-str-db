import { describe, expect, it } from 'vitest';

import { councilAt, fetchCommunityCouncils, type CouncilPolygon } from '../src/councils.ts';

/** A unit square with a hole, and a square beside it. */
const COUNCILS: CouncilPolygon[] = [
  {
    council: 'Downtown',
    rings: [
      [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]],
      [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]],
    ],
  },
  { council: 'Fairview', rings: [[[1, 0], [1, 1], [2, 1], [2, 0], [1, 0]]] },
];

describe('councilAt', () => {
  it('names the council whose polygon holds the coordinate', () => {
    expect(councilAt(COUNCILS, 0.2, 0.2)).toBe('Downtown');
    expect(councilAt(COUNCILS, 0.5, 1.5)).toBe('Fairview');
  });

  it('is null in a hole or outside every council', () => {
    expect(councilAt(COUNCILS, 0.5, 0.5)).toBeNull();
    expect(councilAt(COUNCILS, 5, 5)).toBeNull();
  });
});

describe('the live council layer', () => {
  it('places Girdwood and downtown Anchorage', async () => {
    const councils = await fetchCommunityCouncils();

    expect(new Set(councils.map((c) => c.council)).size).toBeGreaterThan(30);
    // 257 Echo Ridge Dr, Girdwood, and 525 W 3rd Ave, as the geocoder places them.
    expect(councilAt(councils, 60.951486, -149.120567)).toBe('Girdwood');
    expect(councilAt(councils, 61.219642, -149.892467)).toBe('Downtown');
  });
});
