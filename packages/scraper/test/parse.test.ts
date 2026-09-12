import { describe, expect, it } from 'vitest';

import { parseListing } from '../src/parse.ts';
import { makeSearchListing } from './fixtures.ts';

describe('parseListing', () => {
  it('reads counts out of the free-text primary lines', () => {
    const parsed = parseListing(
      makeSearchListing(7, { primaryLines: ['2 bedrooms', '3 beds', '1.5 baths', '6 guests'] }),
    );

    expect(parsed.bedrooms).toBe(2);
    expect(parsed.beds).toBe(3);
    expect(parsed.bathrooms).toBe(1.5);
    expect(parsed.guestCapacity).toBe(6);
  });

  it('does not invent a bedroom count from a studio’s bed line', () => {
    const parsed = parseListing(makeSearchListing(7, { primaryLines: ['1 bed', '1 bath'] }));

    expect(parsed.bedrooms).toBeNull();
    expect(parsed.beds).toBe(1);
  });

  it('leaves every count null when the lines say nothing', () => {
    const parsed = parseListing(makeSearchListing(7, { primaryLines: ['Sep 18 – 23'] }));

    expect([parsed.bedrooms, parsed.beds, parsed.bathrooms, parsed.guestCapacity]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

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
