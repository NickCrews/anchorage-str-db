/** Builders for test listings. */

import type { SearchListing } from '../src/api/search.ts';

export function makeSearchListing(
  roomId: number | bigint,
  overrides: Partial<SearchListing> = {},
): SearchListing {
  return {
    roomId: BigInt(roomId),
    name: `Cabin ${roomId}`,
    title: 'Home in Anchorage',
    latitude: 61.19,
    longitude: -149.89,
    ratingValue: null,
    reviewCount: null,
    badges: [],
    priceQualifier: null,
    priceAmount: null,
    priceBreakdown: [],
    ...overrides,
  };
}
