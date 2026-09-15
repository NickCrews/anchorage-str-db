/**
 * Turn a standardized search result into the flat fields that are stored.
 *
 * Bed, bedroom and bathroom counts, and room type, come from the listing page instead (see
 * `listingPage.ts`). Search cards show them only as free text, never carry a
 * guest line, and omit the bath line on some days and not others.
 */

import type { SearchListing } from './api/search.ts';

const PER_NIGHT_RE = /x\s*\$?([\d,]+(?:\.\d+)?)/;

export interface ParsedListing {
  /** `bigint`; see `SearchListing.listingId`. */
  listingId: bigint;
  name: string | null;
  propertyTitle: string | null;
  lat: number | null;
  lng: number | null;
  url: string;
  ratingValue: number | null;
  reviewCount: number | null;
  badges: string[];
  priceHintPerNight: number | null;
  priceQualifier: string | null;
}

/**
 * The nightly rate from the price breakdown ("5 nights x $285.29" -> 285.29),
 * else the displayed price, which may be a stay total.
 */
function extractPriceHint(listing: SearchListing): number | null {
  const first = listing.priceBreakdown[0];
  if (first) {
    const match = PER_NIGHT_RE.exec(first.description);
    if (match) return Number(match[1]!.replaceAll(',', ''));
  }
  return listing.priceAmount;
}

export function parseListing(listing: SearchListing): ParsedListing {
  return {
    listingId: listing.listingId,
    name: listing.name,
    propertyTitle: listing.title,
    lat: listing.latitude,
    lng: listing.longitude,
    url: `https://www.airbnb.com/rooms/${listing.listingId}`,
    ratingValue: listing.ratingValue,
    reviewCount: listing.reviewCount,
    badges: [...listing.badges],
    priceHintPerNight: extractPriceHint(listing),
    priceQualifier: listing.priceQualifier,
  };
}
