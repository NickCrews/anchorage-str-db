import { describe, expect, it } from 'vitest';

import { parseListing } from '../src/parse.ts';
import { makeSearchListing } from './fixtures.ts';

describe('parseListing', () => {
  it('takes the nightly rate out of the breakdown’s own arithmetic', () => {
    const parsed = parseListing(
      makeSearchListing(7, {
        priceAmount: 914,
        priceBreakdown: [{ description: '5 nights x $1,160.80', amount: 5804 }],
      }),
    );

    expect(parsed.priceHintPerNight).toBe(1160.8);
  });

  it('falls back to the displayed figure when there is no breakdown', () => {
    const parsed = parseListing(makeSearchListing(7, { priceAmount: 914 }));

    expect(parsed.priceHintPerNight).toBe(914);
  });

  it('builds the canonical listing url from the room id', () => {
    // A 19-digit id, which a `number` would round.
    expect(parseListing(makeSearchListing(1602507228357075578n)).url).toBe(
      'https://www.airbnb.com/rooms/1602507228357075578',
    );
  });
});
