/**
 * Turn a standardized search result into the flat fields we store.
 *
 * Airbnb's search response doesn't have dedicated bedroom/bed/bathroom count
 * fields — they're only expressed as free-text lines like "1 bedroom", "4
 * beds", "1 bath" in `structuredContent.primaryLine`. This module regexes
 * those out rather than trusting the accompanying `type` tag (BEDINFO shows
 * up on both bedroom and bed lines in practice), which is a good deal more
 * robust to Airbnb wording changes.
 */

import type { SearchListing } from './airbnb/search.ts';

const COUNT_RE = /(\d+(?:\.\d+)?)\s*(bedroom|bed|bath|guest)s?\b/i;
const PER_NIGHT_RE = /x\s*\$?([\d,]+(?:\.\d+)?)/;

export interface ParsedListing {
  /** `bigint` — see `SearchListing.roomId` for why a number will not do. */
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
    // A "bed" count only appears standalone on studios that have no separate
    // "bedroom" line; don't invent a bedroom count from it.
    bedrooms: whole('bedroom'),
    beds: whole('bed'),
    bathrooms: counts.get('bath') ?? null,
    guestCapacity: whole('guest'),
  };
}

/**
 * The nightly rate, read out of the price breakdown's own arithmetic
 * ("5 nights x $285.29" -> 285.29) where Airbnb shows it, and otherwise the
 * displayed figure — which the qualifier says is a stay total as often as a
 * nightly rate, hence "hint".
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
