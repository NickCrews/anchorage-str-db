/**
 * Airbnb's `StaysPdpSections` endpoint, asked only for the booking sidebar:
 * the price of one stay at one listing, for given check-in and check-out
 * dates.
 *
 * The calendar endpoint returns no price to an unauthenticated caller, and the
 * listing page renders none even with dates; this is the request the page
 * makes to fill in its price. It prices only a stay that is still bookable.
 * See `docs/research/airbnb-calendar-price.md`.
 */

import { requestJson } from './http.ts';
import { parsePriceAmount } from './search.ts';

/** Persisted-query hash for `StaysPdpSections`. Airbnb rotates it; 400s mean it changed. */
const OPERATION_ID = '80c7889b4b0027d99ffea830f6c0d4911a6e863a957cbe1044823f0fc746bf1f';

export interface PriceQuoteQuery {
  apiKey: string;
  roomId: string;
  /** ISO `YYYY-MM-DD`. */
  checkIn: string;
  checkOut: string;
  currency: string;
  language: string;
  timeoutMs?: number | undefined;
}

export interface PriceQuoteResponse {
  /**
   * What the sidebar says, verbatim: `"$241 for 2 nights, originally $269"`,
   * or Airbnb's reason there is no price, e.g. `"Those dates are not
   * available"`.
   */
  label: string | null;
  /** The stay's price as displayed, after any discount: `"$241"` -> 241. */
  total: number | null;
  /** Price-detail lines, e.g. `"2 nights x $120.50: $241.00"`, `"Cleaning fee: $75.00"`. */
  breakdown: string[];
}

function encodeId(typeName: string, roomId: string): string {
  return Buffer.from(`${typeName}:${roomId}`).toString('base64');
}

/** One request. */
export async function fetchPriceQuote(query: PriceQuoteQuery): Promise<unknown> {
  const variables = {
    id: encodeId('StayListing', query.roomId),
    demandStayListingId: encodeId('DemandStayListing', query.roomId),
    pdpSectionsRequest: {
      adults: '1',
      layouts: ['SIDEBAR', 'SINGLE_COLUMN'],
      pets: 0,
      preview: false,
      privateBooking: false,
      bypassTargetings: false,
      staysBookingMigrationEnabled: false,
      useNewSectionWrapperApi: false,
      sectionIds: ['BOOK_IT_SIDEBAR'],
      checkIn: query.checkIn,
      checkOut: query.checkOut,
    },
  };
  const params = new URLSearchParams({
    operationName: 'StaysPdpSections',
    locale: query.language,
    currency: query.currency,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: OPERATION_ID } }),
  });
  return requestJson(`https://www.airbnb.com/api/v3/StaysPdpSections/${OPERATION_ID}?${params}`, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': query.language,
      'X-Airbnb-Api-Key': query.apiKey,
    },
    timeoutMs: query.timeoutMs,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read the booking sidebar out of a response. Throws if the response has no
 * sidebar section, which means the request or the response shape is wrong
 * rather than that the stay is unavailable.
 */
export function standardizePriceQuote(raw: unknown): PriceQuoteResponse {
  const sections =
    asRecord(asRecord(asRecord(asRecord(asRecord(raw)['data'])['presentation'])['stayProductDetailPage'])['sections'])['sections'];
  const sidebar = (Array.isArray(sections) ? sections : [])
    .map(asRecord)
    .find((section) => section['sectionId'] === 'BOOK_IT_SIDEBAR');
  if (!sidebar) throw new Error('price quote response has no BOOK_IT_SIDEBAR section');

  const section = asRecord(sidebar['section']);
  const price = asRecord(section['structuredDisplayPrice']);
  const line = asRecord(price['primaryLine']);

  const breakdown: string[] = [];
  const details = asRecord(price['explanationData'])['priceDetails'];
  for (const group of Array.isArray(details) ? details : []) {
    const items = asRecord(group)['items'];
    for (const item of Array.isArray(items) ? items : []) {
      const description = asString(asRecord(item)['description']);
      const amount = asString(asRecord(item)['priceString']);
      if (description !== null) breakdown.push(amount === null ? description : `${description}: ${amount}`);
    }
  }

  return {
    label: asString(line['accessibilityLabel']) ?? asString(section['localizedUnavailabilityMessage']),
    total: parsePriceAmount(line['discountedPrice'] ?? line['price']),
    breakdown,
  };
}
