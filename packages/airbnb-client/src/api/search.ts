/**
 * Airbnb's `StaysSearch` GraphQL endpoint (the website's map search) and the
 * standardizer for its response.
 *
 * Of the `rawParams`, only the bbox corners and `price_min`/`price_max`
 * select listings. `placeId` and `query` are placeholders that map search
 * ignores when `searchByMap` is true; leave them as they are.
 */

import { requestJson } from './http.ts';

/** Persisted-query hash for `StaysSearch`. Airbnb rotates it; 400s mean it changed. */
export const OPERATION_ID = 'aec09eb74dbd01c4019adbb6b4fcc3cc2ca224457ebcc3a2219bb4f4f5c8f206';

const TREATMENT_FLAGS = [
  'feed_map_decouple_m11_treatment',
  'stays_search_rehydration_treatment_desktop',
  'stays_search_rehydration_treatment_moweb',
  'selective_query_feed_map_homepage_desktop_treatment',
  'selective_query_feed_map_homepage_moweb_treatment',
];

export interface BoundingBox {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
}

export interface SearchQuery {
  apiKey: string;
  box: BoundingBox;
  zoom: number;
  currency: string;
  language: string;
  /** Omit for an unfiltered search. */
  priceMinUsd?: number | undefined;
  /** Omit for the open-ended top band. */
  priceMaxUsd?: number | undefined;
  timeoutMs?: number | undefined;
}

function rawParams(query: SearchQuery): Array<{ filterName: string; filterValues: string[] }> {
  const params: Array<[string, string]> = [
    ['cdnCacheSafe', 'false'],
    ['channel', 'EXPLORE'],
    ['datePickerType', 'calendar'],
    ['flexibleTripLengths', 'one_week'],
    // Airbnb caps this at 40 per page. It does not lift the 280-item cap on
    // a result set.
    ['itemsPerGrid', '50'],
    ['monthlyLength', '3'],
    ['monthlyStartDate', '2024-02-01'],
    ['neLat', String(query.box.neLat)],
    ['neLng', String(query.box.neLng)],
    ['placeId', 'ChIJpTeBx6wjq5oROJeXkPCSSSo'],
    ['priceFilterInputType', '0'],
    ['query', 'Galapagos Island, Ecuador'],
    ['screenSize', 'large'],
    ['refinementPaths', '/homes'],
    ['searchByMap', 'true'],
    ['swLat', String(query.box.swLat)],
    ['swLng', String(query.box.swLng)],
    ['tabId', 'home_tab'],
    ['version', '1.8.3'],
    ['zoomLevel', String(query.zoom)],
  ];
  // No check-in/check-out, so the search returns every listing in the area,
  // not only those free on particular nights.
  if (query.priceMinUsd !== undefined && query.priceMinUsd > 0) {
    params.push(['price_min', String(query.priceMinUsd)]);
  }
  if (query.priceMaxUsd !== undefined && query.priceMaxUsd > 0) {
    params.push(['price_max', String(query.priceMaxUsd)]);
  }
  return params.map(([filterName, value]) => ({ filterName, filterValues: [value] }));
}

/** One `StaysSearch` request. Never follows a cursor — see `search.ts` in the scraper. */
export async function fetchSearchPage(query: SearchQuery): Promise<unknown> {
  const params = rawParams(query);
  const request = {
    cursor: '',
    requestedPageType: 'STAYS_SEARCH',
    metadataOnly: false,
    source: 'structured_search_input_header',
    searchType: 'user_map_move',
    treatmentFlags: TREATMENT_FLAGS,
    rawParams: params,
  };
  const body = {
    operationName: 'StaysSearch',
    extensions: { persistedQuery: { version: 1, sha256Hash: OPERATION_ID } },
    variables: {
      skipExtendedSearchParams: false,
      includeMapResults: true,
      isLeanTreatment: false,
      // Required for the dynamic StaysSearch hash.
      aiSearchEnabled: false,
      staysMapSearchRequestV2: request,
      staysSearchRequest: { ...request, maxMapItems: 9999 },
    },
  };
  const url =
    `https://www.airbnb.com/api/v3/StaysSearch/${OPERATION_ID}` +
    `?operationName=StaysSearch&locale=${encodeURIComponent(query.language)}` +
    `&currency=${encodeURIComponent(query.currency)}`;
  return requestJson(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': query.language,
      'X-Airbnb-Api-Key': query.apiKey,
    },
    body: JSON.stringify(body),
    timeoutMs: query.timeoutMs,
  });
}

// --------------------------------------------------------------------------
// standardizing the response

/**
 * One search result, limited to the fields the pipeline stores. The response
 * also has images, fees and discounts, which are not read.
 */
export interface SearchListing {
  /**
   * `bigint`: newer listing ids are 19 digits (e.g. `1602507228357075578`),
   * which a JS number would round to a different id.
   */
  listingId: bigint;
  name: string | null;
  title: string | null;
  /** `null`, not `0`, when Airbnb gave no coordinate. See this directory's README. */
  latitude: number | null;
  longitude: number | null;
  ratingValue: number | null;
  reviewCount: number | null;
  badges: string[];
  /** e.g. "for 5 nights". */
  priceQualifier: string | null;
  /** The displayed nightly-or-total figure, in the search's currency. */
  priceAmount: number | null;
  /** Price-detail lines, e.g. `{ description: "5 nights x $160.80" }`. */
  priceBreakdown: Array<{ description: string; amount: number | null }>;
}

export interface SearchResponse {
  listings: SearchListing[];
  /** Pages in the result set, from `paginationInfo.pageCursors`. See `../search.ts`. */
  pageCount: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function dig(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const PRICE_RE = /\d+(?:\.\d+)?/;

/**
 * `"$1,234.50"` -> `1234.5`. The sign is read from the start of the string,
 * since discounts are formatted `"-$110.00"`.
 */
export function parsePriceAmount(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replaceAll(',', '').trim();
  const match = PRICE_RE.exec(cleaned);
  if (!match) return null;
  return cleaned.startsWith('-') ? -Number(match[0]) : Number(match[0]);
}

/**
 * `"RGVtYW5kU3RheUxpc3Rpbmc6MTYwMjUwNzIyODM1NzA3NTU3OA=="` ->
 * `1602507228357075578n`.
 *
 * Airbnb base64-encodes `DemandStayListing:<id>`. Returns `null` for anything
 * else, and the caller drops that result.
 */
export function decodeListingId(encoded: unknown): bigint | null {
  if (typeof encoded !== 'string' || encoded === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // Node's base64 decoder accepts any string, so validate the decoded shape.
  const match = /^[A-Za-z]+:(\d+)$/.exec(decoded);
  return match?.[1] ? BigInt(match[1]) : null;
}

/** `"4.96 (50)"` -> `{ value: 4.96, reviewCount: 50 }`. */
function parseAvgRating(raw: unknown): { value: number | null; reviewCount: number | null } {
  const parts = typeof raw === 'string' ? raw.split(' ') : [];
  if (parts.length !== 2) return { value: null, reviewCount: null };
  // A comma decimal separator in non-English locales.
  const value = Number(parts[0]!.replace(',', '.'));
  const reviews = /\d+/.exec(parts[1]!);
  return {
    value: Number.isFinite(value) ? value : null,
    reviewCount: reviews ? Number(reviews[0]) : null,
  };
}

/** Flatten one `StaysSearch` response into `SearchListing`s. */
export function standardizeSearchResponse(raw: unknown): SearchResponse {
  const results = asRecord(dig(raw, 'data.presentation.staysSearch.results'));
  const pageCount = asArray(dig(results, 'paginationInfo.pageCursors')).length;

  const listings: SearchListing[] = [];
  for (const result of asArray(results['searchResults'])) {
    if (dig(result, '__typename') !== 'StaySearchResult') continue;
    const listingId = decodeListingId(dig(result, 'demandStayListing.id'));
    if (listingId === null) continue;

    const price = asRecord(dig(result, 'structuredDisplayPrice'));
    const rating = parseAvgRating(dig(result, 'avgRatingLocalized'));

    const breakdown: SearchListing['priceBreakdown'] = [];
    for (const group of asArray(dig(price, 'explanationData.priceDetails'))) {
      for (const item of asArray(dig(group, 'items'))) {
        const description = asString(dig(item, 'description'));
        if (description !== null) {
          breakdown.push({ description, amount: parsePriceAmount(dig(item, 'priceString')) });
        }
      }
    }

    listings.push({
      listingId,
      name: asString(
        dig(result, 'demandStayListing.description.name.localizedStringWithTranslationPreference'),
      ),
      title: asString(dig(result, 'title')),
      latitude: asNumber(dig(result, 'demandStayListing.location.coordinate.latitude')),
      longitude: asNumber(dig(result, 'demandStayListing.location.coordinate.longitude')),
      ratingValue: rating.value,
      reviewCount: rating.reviewCount,
      badges: asArray(dig(result, 'badges'))
        .map((badge) => asString(dig(badge, 'loggingContext.badgeType')))
        .filter((type): type is string => type !== null),
      // For a discounted listing, prefer the undiscounted original price.
      priceQualifier: asString(dig(price, 'primaryLine.qualifier')),
      priceAmount:
        parsePriceAmount(dig(price, 'primaryLine.originalPrice')) ??
        parsePriceAmount(dig(price, 'primaryLine.price')),
      priceBreakdown: breakdown,
    });
  }
  return { listings, pageCount };
}
