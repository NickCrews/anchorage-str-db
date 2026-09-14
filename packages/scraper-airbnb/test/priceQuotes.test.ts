import { beforeEach, describe, expect, it } from 'vitest';

import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

import { standardizePriceQuote } from '../src/api/priceQuote.ts';
import type { CalendarNight, CalendarResult } from '../src/calendars.ts';
import { resetPace } from '../src/pace.ts';
import { chooseStayWindow, fetchPriceQuotes, type PriceQuote } from '../src/priceQuotes.ts';

beforeEach(() => {
  resetPace({ rate: 1e6 });
});

/** A response with a booking sidebar; its section is shaped like a real one (room 10403135). */
function response(section: Record<string, unknown>): unknown {
  return {
    data: {
      presentation: {
        stayProductDetailPage: {
          sections: {
            sections: [
              { sectionId: 'POLICIES_DEFAULT', section: {} },
              { sectionId: 'BOOK_IT_SIDEBAR', section },
            ],
          },
        },
      },
    },
  };
}

describe('standardizePriceQuote', () => {
  it('reads the discounted total, the label, and the price details', () => {
    const quote = standardizePriceQuote(
      response({
        structuredDisplayPrice: {
          primaryLine: {
            __typename: 'DiscountedDisplayPriceLine',
            accessibilityLabel: '$241 for 2 nights, originally $269',
            discountedPrice: '$241',
            originalPrice: '$269',
            qualifier: 'for 2 nights',
          },
          explanationData: {
            priceDetails: [
              { items: [{ description: '2 nights x $120.50', priceString: '$241.00' }] },
              { __typename: 'DisplayPriceExplanationDisclaimer', content: 'Pay $0 today.' },
            ],
          },
        },
        localizedUnavailabilityMessage: null,
      }),
    );

    expect(quote).toEqual({
      label: '$241 for 2 nights, originally $269',
      total: 241,
      breakdown: ['2 nights x $120.50: $241.00'],
    });
  });

  it('reads an undiscounted price and a thousands separator', () => {
    const quote = standardizePriceQuote(
      response({
        structuredDisplayPrice: {
          primaryLine: { accessibilityLabel: '$1,293 for 3 nights', price: '$1,293' },
          explanationData: {
            priceDetails: [
              {
                items: [
                  { description: '3 nights x $458.33', priceString: '$1,375.00' },
                  { description: 'Last-minute discount', priceString: '-$82.50' },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(quote.total).toBe(1293);
    expect(quote.breakdown).toEqual([
      '3 nights x $458.33: $1,375.00',
      'Last-minute discount: -$82.50',
    ]);
  });

  it('keeps Airbnb’s reason when the stay is not bookable', () => {
    const quote = standardizePriceQuote(
      response({
        structuredDisplayPrice: null,
        localizedUnavailabilityMessage: 'Those dates are not available',
      }),
    );

    expect(quote).toEqual({ label: 'Those dates are not available', total: null, breakdown: [] });
  });

  it('throws on a response with no booking sidebar', () => {
    expect(() => standardizePriceQuote({ data: { presentation: null } })).toThrow(/BOOK_IT_SIDEBAR/);
  });
});

const TODAY: IsoDate = '2026-09-13';

/** Nights from `TODAY`, each `open` or not, with the given minimum stay. */
function calendar(pattern: string, minNights = 1, roomId = '1'): CalendarResult {
  const nights: CalendarNight[] = [...pattern].map((c, i) => ({
    nightDate: addDays(TODAY, i),
    available: c !== 'x',
    availableForCheckin: c === 'o',
    availableForCheckout: c !== '-',
    minNights,
    maxNights: null,
  }));
  return { roomId, nights, error: null };
}

describe('chooseStayWindow', () => {
  // o: open for check-in; c: available, but not for check-in; x: booked;
  // -: booked, and no check-out allowed either.
  it('takes the first check-in night from tomorrow on', () => {
    expect(chooseStayWindow(calendar('oooo'), addDays(TODAY, 1))).toEqual({
      roomId: '1',
      checkIn: '2026-09-14',
      nights: 1,
    });
  });

  it('skips booked nights and nights closed to check-in', () => {
    expect(chooseStayWindow(calendar('oxcoo'), addDays(TODAY, 1))?.checkIn).toBe('2026-09-16');
  });

  it('asks for the minimum stay, all of it available', () => {
    // Two nights from the 14th would run into the booked 15th.
    expect(chooseStayWindow(calendar('ooxooo', 2), addDays(TODAY, 1))).toEqual({
      roomId: '1',
      checkIn: '2026-09-16',
      nights: 2,
    });
  });

  it('needs a check-out day that allows check-out', () => {
    expect(chooseStayWindow(calendar('oo-oo'), addDays(TODAY, 1))?.checkIn).toBe('2026-09-16');
  });

  it('is null for a fully booked calendar', () => {
    expect(chooseStayWindow(calendar('xxxx'), addDays(TODAY, 1))).toBeNull();
  });
});

describe('fetchPriceQuotes', () => {
  it('quotes only listings with a readable calendar and a bookable stay', async () => {
    const asked: string[] = [];
    const quotes = await fetchPriceQuotes(
      [
        calendar('ooo', 1, '1'),
        calendar('xxx', 1, '2'),
        { roomId: '3', nights: [], error: 'HttpError: HTTP 503' },
      ],
      {
        firstCheckIn: addDays(TODAY, 1),
        fetchOne: async (window): Promise<PriceQuote> => {
          asked.push(window.roomId);
          return { ...window, label: '$90 for 1 night', total: 90, breakdown: [], error: null };
        },
      },
    );

    expect(asked).toEqual(['1']);
    expect(quotes.map((quote) => [quote.roomId, quote.checkIn, quote.total])).toEqual([
      ['1', '2026-09-14', 90],
    ]);
  });
});
