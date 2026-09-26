/**
 * Airbnb's `UserProfileBeehiveListingQuery` endpoint: one page of the
 * listings on a host's profile (`airbnb.com/users/show/<host id>`), wherever
 * they are.
 *
 * Offset-paginated and ordered the same way on every request. The response
 * carries no total count, so the caller pages until a short page (see
 * `../hostListings.ts`). `limit` is honoured up to at least 1000.
 *
 * A host id no account has returns an empty list, not an error, exactly like
 * a host with nothing listed. See `docs/research/airbnb-host-listings.md`.
 *
 * Each entry also carries a title, photo, rating and property type, but no
 * coordinate or city, so only the ids are read.
 */

import { requestJson } from './http.ts';

const OPERATION_ID = '529ca816b8be0619618d48b31bf46c379543e297fd68c0a953922927e5497b43';

export interface FetchHostListingsPageOptions {
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
 * One page of the host's listing ids, in Airbnb's order. Throws if the
 * response carries GraphQL errors or no listing list, which is what a rotated
 * hash or a changed shape looks like.
 */
export async function fetchHostListingsPage(options: FetchHostListingsPageOptions): Promise<string[]> {
  const query = new URLSearchParams({
    operationName: 'UserProfileBeehiveListingQuery',
    locale: options.language,
    currency: options.currency,
    variables: JSON.stringify({
      // A string: newer host ids are 19 digits, beyond what a JS number holds.
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
    throw new Error(`profile listings query for host ${hostId} returned errors: ${messages}`);
  }
  const listings = data.data?.beehive?.getListOfListings?.listings;
  if (!Array.isArray(listings)) {
    throw new Error(`profile listings response for host ${hostId} has no listings list`);
  }
  // Every entry must have an id: the caller advances the offset by the page's
  // length, so a dropped entry would be miscounted rather than skipped.
  return listings.map((listing) => {
    if (typeof listing.id !== 'string' || !/^\d+$/.test(listing.id)) {
      throw new Error(`a profile listing for host ${hostId} has no listing id`);
    }
    return listing.id;
  });
}
