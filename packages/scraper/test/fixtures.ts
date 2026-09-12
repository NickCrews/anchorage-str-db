/**
 * Shared builders. `makeListing` is a plausible parsed listing that tests
 * vary one field of at a time.
 */

import type { SearchListing } from '../src/airbnb/search.ts';
import type { ParsedListing } from '../src/parse.ts';

export interface MakeListingOptions {
  bedrooms?: number;
  lat?: number;
  badges?: string[];
}

export function makeListing(
  id: number | bigint,
  name: string,
  options: MakeListingOptions = {},
): ParsedListing {
  return {
    listingId: BigInt(id),
    name,
    propertyTitle: 'Tiny home',
    bedrooms: options.bedrooms ?? 1,
    beds: 1,
    bathrooms: 1,
    guestCapacity: 2,
    lat: options.lat ?? 60.95,
    lng: -149.1,
    url: `https://airbnb.com/rooms/${id}`,
    ratingValue: 4.9,
    reviewCount: 10,
    badges: options.badges ?? [],
    priceHintPerNight: 150,
    priceQualifier: 'for 5 nights',
  };
}

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
    primaryLines: [],
    ratingValue: null,
    reviewCount: null,
    badges: [],
    priceQualifier: null,
    priceAmount: null,
    priceBreakdown: [],
    ...overrides,
  };
}
