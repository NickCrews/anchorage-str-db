/**
 * Airbnb's `StaysPdpBookItQuery` endpoint: the booking sidebar's price for one
 * stay at one listing, for given check-in and check-out dates.
 *
 * The calendar endpoint returns no price to an unauthenticated caller, and the
 * listing page renders none even with dates; this is the request the page
 * makes to fill in its price. It prices only a stay that is still bookable.
 * See `docs/research/airbnb-calendar-price.md`.
 */

import { requestJson } from './http.ts';
import { parsePriceAmount } from './search.ts';

/** Persisted-query hash for `StaysPdpBookItQuery`. Airbnb rotates it; 400s mean it changed. */
export const OPERATION_ID = '9afe04ccb0e7082750ec50fb56513196422b992449bb0406c3dffcc954863b68';

export interface PriceQuoteQuery {
  apiKey: string;
  listingId: string;
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

/** One request. */
export async function fetchPriceQuote(query: PriceQuoteQuery): Promise<unknown> {
  const dates = { startDate: query.checkIn, endDate: query.checkOut };
  // The query rejects a request that leaves out any of these variables, so
  // every one the website sends is here, with the optional fragments off.
  const variables = {
    // A GraphQL id: base64 of `DemandStayListing:<listing id>`.
    id: Buffer.from(`DemandStayListing:${query.listingId}`).toString('base64'),
    dateRange: dates,
    guestCounts: null,
    includePdpMigrationBookItCalendarSheetFragment: false,
    includePdpMigrationBookItFloatingFooterFragment: false,
    includePdpMigrationBookItNavFragment: false,
    includePdpMigrationBookItSidebarFragment: true,
    includeGalleryBookItCtaFragment: false,
    includeOverviewMerchandisingTipsFragment: false,
    includeStaysPdpPriceHeatmapFragment: false,
    priceHeatmapDateRange: dates,
    p3ImpressionId: null,
    selectedCancellationPolicyId: null,
    causeId: null,
    selectedGuestOptionId: null,
    federatedSearchId: null,
    interactionType: null,
    logEntityPricingViewEvent: false,
  };
  const params = new URLSearchParams({
    operationName: 'StaysPdpBookItQuery',
    locale: query.language,
    currency: query.currency,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: OPERATION_ID } }),
  });
  return requestJson(`https://www.airbnb.com/api/v3/StaysPdpBookItQuery/${OPERATION_ID}?${params}`, {
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
 * The displayed total from a `primaryLine`. A `DiscountedDisplayPriceLine` has
 * `discountedPrice`, a `QualifiedDisplayPriceLine` has `price`, and an
 * `OrderedDisplayPriceLine` carries the same fields on its `orderedComponents`.
 */
function lineTotal(line: Record<string, unknown>): number | null {
  const parts = [line, ...(Array.isArray(line['orderedComponents']) ? line['orderedComponents'] : []).map(asRecord)];
  for (const key of ['discountedPrice', 'price']) {
    for (const part of parts) {
      const amount = parsePriceAmount(part[key]);
      if (amount !== null) return amount;
    }
  }
  return null;
}

/**
 * Read the booking sidebar out of a response. Throws if the response has
 * GraphQL errors or no `bookIt`, which means the request or the response
 * shape is wrong rather than that the stay is unavailable.
 */
export function standardizePriceQuote(raw: unknown): PriceQuoteResponse {
  const errors = asRecord(raw)['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((error) => asString(asRecord(error)['message']) ?? '?').join('; ');
    throw new Error(`price quote response has errors: ${messages}`);
  }
  const bookIt = asRecord(asRecord(asRecord(asRecord(raw)['data'])['node'])['pdpPresentation'])['bookIt'];
  if (typeof bookIt !== 'object' || bookIt === null) {
    throw new Error('price quote response has no pdpPresentation.bookIt');
  }

  const section = asRecord(bookIt);
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
    label:
      asString(line['accessibilityLabel']) ??
      asString(asRecord(section['availability'])['unavailabilityMessage']),
    total: lineTotal(line),
    breakdown,
  };
}
