/** The `StaysSearch` standardizer, against the shape of a captured response. */

import { describe, expect, it } from 'vitest';

import {
  decodeListingId,
  parsePriceAmount,
  standardizeSearchResponse,
} from '../src/api/search.ts';

/** Base64 of "DemandStayListing:1602507228357075578". */
const ENCODED_ID = 'RGVtYW5kU3RheUxpc3Rpbmc6MTYwMjUwNzIyODM1NzA3NTU3OA==';

function response(searchResults: unknown[], pageCursors = ['c']): unknown {
  return {
    data: {
      presentation: {
        staysSearch: { results: { searchResults, paginationInfo: { pageCursors } } },
      },
    },
  };
}

const FULL_RESULT = {
  __typename: 'StaySearchResult',
  title: 'Apartment in Wasilla',
  avgRatingLocalized: '4.96 (50)',
  demandStayListing: {
    id: ENCODED_ID,
    description: { name: { localizedStringWithTranslationPreference: 'Denali View' } },
    location: { coordinate: { latitude: 61.443, longitude: -149.8749 } },
  },
  structuredContent: {
    primaryLine: [
      { body: '2 bedrooms', type: 'BEDINFO' },
      { body: '3 beds', type: 'BEDINFO' },
      { body: '1 bath', type: 'BATHROOMINFO' },
    ],
  },
  badges: [{ loggingContext: { badgeType: 'TOP_X_GUEST_FAVORITE' } }],
  structuredDisplayPrice: {
    primaryLine: {
      discountedPrice: '$804',
      originalPrice: '$914',
      qualifier: 'for 5 nights',
    },
    explanationData: {
      priceDetails: [
        {
          items: [
            {
              __typename: 'DiscountedExplanationLineItem',
              description: '5 nights x $160.80',
              priceString: '$804.00',
            },
          ],
        },
        { __typename: 'DisplayPriceExplanationDisclaimer', content: 'Norman lowered the price.' },
      ],
    },
  },
};

describe('standardizeSearchResponse', () => {
  it('flattens a full search result', () => {
    const { listings, pageCount } = standardizeSearchResponse(
      response([FULL_RESULT], ['c1', 'c2', 'c3']),
    );

    expect(pageCount).toBe(3);
    expect(listings).toEqual([
      {
        listingId: 1602507228357075578n,
        name: 'Denali View',
        title: 'Apartment in Wasilla',
        latitude: 61.443,
        longitude: -149.8749,
        ratingValue: 4.96,
        reviewCount: 50,
        badges: ['TOP_X_GUEST_FAVORITE'],
        priceQualifier: 'for 5 nights',
        // The original price, not the discounted one.
        priceAmount: 914,
        priceBreakdown: [{ description: '5 nights x $160.80', amount: 804 }],
      },
    ]);
  });

  it('skips anything that is not a stay', () => {
    // Airbnb mixes ad slots and section headers into `searchResults`.
    const { listings } = standardizeSearchResponse(
      response([{ __typename: 'StaysSearchMessage' }, FULL_RESULT]),
    );

    expect(listings).toHaveLength(1);
  });

  it('reports a missing coordinate as null rather than as (0, 0)', () => {
    const { listings } = standardizeSearchResponse(
      response([{ ...FULL_RESULT, demandStayListing: { id: ENCODED_ID } }]),
    );

    expect(listings[0]!.latitude).toBeNull();
    expect(listings[0]!.longitude).toBeNull();
  });

  it('drops a result whose id will not decode rather than calling it listing 0', () => {
    const { listings } = standardizeSearchResponse(
      response([{ ...FULL_RESULT, demandStayListing: { id: 'not base64 at all' } }]),
    );

    expect(listings).toEqual([]);
  });

  it('survives a response with no results at all', () => {
    expect(standardizeSearchResponse({})).toEqual({ listings: [], pageCount: 0 });
    expect(standardizeSearchResponse(null)).toEqual({ listings: [], pageCount: 0 });
  });

  it('falls back to the plain price when nothing is discounted', () => {
    const plain = {
      ...FULL_RESULT,
      structuredDisplayPrice: { primaryLine: { price: '$1,250', qualifier: 'night' } },
    };

    expect(standardizeSearchResponse(response([plain])).listings[0]!.priceAmount).toBe(1250);
  });
});

describe('decodeListingId', () => {
  it('decodes Airbnb’s base64 node id without losing precision', () => {
    // 19 digits, past 2^53.
    expect(decodeListingId(ENCODED_ID)).toBe(1602507228357075578n);
  });

  it.each([
    ['', null],
    [null, null],
    [undefined, null],
    // "foobar" — decodes, but is not `Prefix:<digits>`.
    ['Zm9vYmFy', null],
    // "DemandStayListing:" with nothing after it.
    ['RGVtYW5kU3RheUxpc3Rpbmc6', null],
  ])('returns null for %s', (encoded, expected) => {
    expect(decodeListingId(encoded)).toBe(expected);
  });
});

describe('parsePriceAmount', () => {
  it.each([
    ['$804.00', 804],
    ['$1,250', 1250],
    ['-$15.50', -15.5],
    ['', null],
    ['free', null],
    [null, null],
  ])('parses %s', (raw, expected) => {
    expect(parsePriceAmount(raw)).toBe(expected);
  });
});
