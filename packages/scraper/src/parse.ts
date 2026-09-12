/**
 * Turn a standardized search result into the flat fields that are stored.
 *
 * Bedroom, bed, bath and guest counts exist only as text lines like
 * "1 bedroom" or "4 beds", so they are parsed from the text. The lines' `type`
 * tag can't distinguish them: BEDINFO appears on both bedroom and bed lines.
 */

import type { SearchListing } from './airbnb/search.ts';

const COUNT_RE = /(\d+(?:\.\d+)?)\s*(bedroom|bed|bath|guest)s?\b/i;
const PER_NIGHT_RE = /x\s*\$?([\d,]+(?:\.\d+)?)/;

export interface ParsedListing {
  /** `bigint`; see `SearchListing.roomId`. */
  listingId: bigint;
  name: string | null;
  propertyTitle: string | null;
  bedrooms: number | null;
  beds: number | null;
  bathrooms: number | null;
  guestCapacity: number | null;
  lat: number | null;
  lng: number | null;
  url: string;
  ratingValue: number | null;
  reviewCount: number | null;
  badges: string[];
  priceHintPerNight: number | null;
  priceQualifier: string | null;
}

interface Counts {
  bedrooms: number | null;
  beds: number | null;
  bathrooms: number | null;
  guestCapacity: number | null;
}

function extractCounts(primaryLines: readonly string[]): Counts {
  const counts = new Map<string, number>();
  for (const line of primaryLines) {
    const match = COUNT_RE.exec(line);
    if (match) counts.set(match[2]!.toLowerCase(), Number(match[1]));
  }
  const whole = (key: string): number | null => {
    const value = counts.get(key);
    return value === undefined ? null : Math.trunc(value);
  };
  return {
    // Studios have a "bed" line but no "bedroom" line; bedrooms stays null.
    bedrooms: whole('bedroom'),
    beds: whole('bed'),
    bathrooms: counts.get('bath') ?? null,
    guestCapacity: whole('guest'),
  };
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
  const counts = extractCounts(listing.primaryLines);
  return {
    listingId: listing.roomId,
    name: listing.name,
    propertyTitle: listing.title,
    bedrooms: counts.bedrooms,
    beds: counts.beds,
    bathrooms: counts.bathrooms,
    guestCapacity: counts.guestCapacity,
    lat: listing.latitude,
    lng: listing.longitude,
    url: `https://www.airbnb.com/rooms/${listing.roomId}`,
    ratingValue: listing.ratingValue,
    reviewCount: listing.reviewCount,
    badges: [...listing.badges],
    priceHintPerNight: extractPriceHint(listing),
    priceQualifier: listing.priceQualifier,
  };
}
