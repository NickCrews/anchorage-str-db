import { beforeEach, describe, expect, it } from 'vitest';

import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

import { standardizePriceQuote } from '../src/api/priceQuote.ts';
import type { CalendarNight, CalendarResult } from '../src/calendars.ts';
import { resetPace } from '../src/pace.ts';
import { chooseStayWindow, fetchPriceQuotes, type PriceQuote } from '../src/priceQuotes.ts';

beforeEach(() => {
  resetPace({ rate: 1e6 });
});

/** A response whose `bookIt` is shaped like a real one (room 1096318678417782390). */
function response(bookIt: Record<string, unknown>): unknown {
  return { data: { node: { __typename: 'DemandStayListing', pdpPresentation: { bookIt } } } };
}

const AVAILABLE = { isAvailable: true, unavailabilityMessage: null };

describe('standardizePriceQuote', () => {
  it('reads a discounted total from an ordered price line', () => {
    const quote = standardizePriceQuote(
      response({
        availability: AVAILABLE,
        structuredDisplayPrice: {
          primaryLine: {
            __typename: 'OrderedDisplayPriceLine',
            accessibilityLabel: '$1,126 for 7 nights, originally $1,611',
            orderedComponents: [
              { __typename: 'LeadingContentDisplayPriceLineComponent', leadingContent: 'From' },
              { __typename: 'OriginalPriceDisplayPriceLineComponent', originalPrice: '$1,611' },
              { __typename: 'DiscountedPriceDisplayPriceLineComponent', discountedPrice: '$1,126' },
              { __typename: 'QualifierDisplayPriceLineComponent', qualifier: 'for 7 nights' },
            ],
          },
          explanationData: {
            priceDetails: [
              {
                items: [
                  { description: '7 nights x $230.14', priceString: '$1,611.00' },
                  { description: 'Weekly stay discount', priceString: '-$485.00' },
                ],
              },
              { __typename: 'DisplayPriceExplanationDisclaimer', content: 'Pay $0 today.' },
            ],
          },
        },
      }),
    );

    expect(quote).toEqual({
      label: '$1,126 for 7 nights, originally $1,611',
      total: 1126,
      breakdown: ['7 nights x $230.14: $1,611.00', 'Weekly stay discount: -$485.00'],
    });
  });

  it('reads a discounted price line', () => {
    const quote = standardizePriceQuote(
      response({
        availability: AVAILABLE,
        structuredDisplayPrice: {
          primaryLine: {
            __typename: 'DiscountedDisplayPriceLine',
            accessibilityLabel: '$1,594 for 7 nights, originally $1,757',
            discountedPrice: '$1,594',
            originalPrice: '$1,757',
            qualifier: 'for 7 nights',
          },
        },
      }),
    );

    expect(quote.total).toBe(1594);
  });

  it('reads an undiscounted price line', () => {
    const quote = standardizePriceQuote(
      response({
        availability: AVAILABLE,
        structuredDisplayPrice: {
          primaryLine: {
            __typename: 'QualifiedDisplayPriceLine',
            accessibilityLabel: '$2,049 for 7 nights',
            price: '$2,049',
            qualifier: 'for 7 nights',
          },
        },
      }),
    );

    expect(quote).toEqual({ label: '$2,049 for 7 nights', total: 2049, breakdown: [] });
  });

  it('keeps Airbnb’s reason when the stay is not bookable', () => {
    const quote = standardizePriceQuote(
      response({
        availability: { isAvailable: false, unavailabilityMessage: 'Those dates are not available' },
        structuredDisplayPrice: null,
      }),
    );

    expect(quote).toEqual({ label: 'Those dates are not available', total: null, breakdown: [] });
  });

  it('throws on a response with no bookIt', () => {
    expect(() => standardizePriceQuote({ data: { node: null } })).toThrow(/bookIt/);
  });

  it('throws on a response with GraphQL errors', () => {
    expect(() =>
      standardizePriceQuote({ errors: [{ message: 'Sorry, something went wrong.' }], data: null }),
    ).toThrow(/Sorry, something went wrong/);
  });
});

const TODAY: IsoDate = '2026-09-13';

/** Nights from `TODAY`, each `open` or not, with the given minimum stay. */
function calendar(pattern: string, minNights = 1, listingId = '1'): CalendarResult {
  const nights: CalendarNight[] = [...pattern].map((c, i) => ({
    nightDate: addDays(TODAY, i),
    available: c !== 'x',
    availableForCheckin: c === 'o',
    availableForCheckout: c !== '-',
    minNights,
    maxNights: null,
  }));
  return { listingId, nights, error: null };
}

describe('chooseStayWindow', () => {
  // o: open for check-in; c: available, but not for check-in; x: booked;
  // -: booked, and no check-out allowed either.
  it('takes the first check-in night from tomorrow on', () => {
    expect(chooseStayWindow(calendar('oooo'), addDays(TODAY, 1))).toEqual({
      listingId: '1',
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
      listingId: '1',
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
        { listingId: '3', nights: [], error: 'HttpError: HTTP 503' },
      ],
      {
        firstCheckIn: addDays(TODAY, 1),
        fetchOne: async (window): Promise<PriceQuote> => {
          asked.push(window.listingId);
          return { ...window, label: '$90 for 1 night', total: 90, breakdown: [], error: null };
        },
      },
    );

    expect(asked).toEqual(['1']);
    expect(quotes.map((quote) => [quote.listingId, quote.checkIn, quote.total])).toEqual([
      ['1', '2026-09-14', 90],
    ]);
  });
});
