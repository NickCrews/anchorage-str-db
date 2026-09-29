/**
 * Airbnb's `UserProfileBeehiveListingQuery` endpoint: one page of the
 * listings on a host's public profile (`airbnb.com/users/show/<id>`), wherever
 * they are. See `docs/research/airbnb-host-listings.md`.
 *
 * The response carries no total, so a host's count is the length of the list
 * paged to its end (see `../hostListings.ts`). An account that doesn't exist
 * returns an empty list rather than an error.
 */

import { requestJson } from './http.ts';

const OPERATION_ID = '529ca816b8be0619618d48b31bf46c379543e297fd68c0a953922927e5497b43';

export interface FetchHostListingPageOptions {
  apiKey: string;
  hostId: string;
  offset: number;
  limit: number;
  language: string;
  currency: string;
}

interface HostListingsResponse {
  errors?: Array<{ message?: string }>;
  data?: {
    beehive?: {
      getListOfListings?: {
        listings?: Array<{ id?: unknown }>;
      };
    };
  };
}

/**
 * The listing ids on one page, in response order. Throws if the response
 * carries GraphQL errors or no listing list, which is what a rotated hash or
 * a changed shape looks like.
 */
export async function fetchHostListingPage(options: FetchHostListingPageOptions): Promise<string[]> {
  const query = new URLSearchParams({
    operationName: 'UserProfileBeehiveListingQuery',
    locale: options.language,
    currency: options.currency,
    variables: JSON.stringify({
      // A string: newer host ids are 19 digits, and as a JSON number Airbnb
      // rounds them to another account and returns an empty list.
      userId: options.hostId,
      limit: options.limit,
      offset: options.offset,
    }),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: OPERATION_ID },
    }),
  });

  const data = await requestJson<HostListingsResponse>(
    `https://www.airbnb.com/api/v3/UserProfileBeehiveListingQuery/${OPERATION_ID}?${query}`,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Language': options.language,
        'X-Airbnb-Api-Key': options.apiKey,
      },
    },
  );
  return toHostListingIds(data, options.hostId);
}

export function toHostListingIds(data: HostListingsResponse, hostId: string): string[] {
  if (data.errors?.length) {
    const messages = data.errors.map((error) => error.message ?? '?').join('; ');
    throw new Error(`listings query for host ${hostId} returned errors: ${messages}`);
  }
  const listings = data.data?.beehive?.getListOfListings?.listings;
  if (!Array.isArray(listings)) {
    throw new Error(`listings response for host ${hostId} has no listing list`);
  }
  // Every entry must have an id: the caller pages by counting entries and
  // detects overlapping pages by id.
  return listings.map((listing) => {
    if (typeof listing.id !== 'string' || !/^\d+$/.test(listing.id)) {
      throw new Error(`a listing for host ${hostId} has no id`);
    }
    return listing.id;
  });
}
