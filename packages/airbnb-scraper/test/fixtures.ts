/** Builders for test listings. */

import type { ParsedListing } from '@anchorage-str-db/airbnb-client/parse';

export interface MakeListingOptions {
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
