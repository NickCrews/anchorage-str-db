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
 * The response is returned as text, so the caller can store it verbatim
 * when `parseHostListingsPage` can't keep every field of it.
 */

import { request } from './http.ts';

const OPERATION_ID = '529ca816b8be0619618d48b31bf46c379543e297fd68c0a953922927e5497b43';

export interface FetchHostListingsPageOptions {
  apiKey: string;
  hostId: string;
  offset: number;
  limit: number;
  language: string;
  currency: string;
}

/** One page of the host's profile listings: the response body, verbatim. */
export async function fetchHostListingsPage(options: FetchHostListingsPageOptions): Promise<string> {
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

  return request(
    `https://www.airbnb.com/api/v3/UserProfileBeehiveListingQuery/${OPERATION_ID}?${query}`,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Language': options.language,
        'X-Airbnb-Api-Key': options.apiKey,
      },
    },
  );
}

/**
 * One entry on a host's profile, every field Airbnb sends for it, under our
 * names. A field Airbnb omits or nulls is null.
 */
export interface ProfileListing {
  /** `id`. */
  listingId: string;
  /** `nameOrPlaceholderName`: the listing's title. */
  name: string | null;
  /** `pictureUrl`: the cover photo. */
  photoUrl: string | null;
  /** `propertyTypeName`, verbatim: "Chalet", "Hotel". */
  buildingType: string | null;
  /** `localizedRoomType`, verbatim: "Entire home/apt". */
  listingType: string | null;
  /** `roomTypeCategory`, Airbnb's key for the same: "entire_home". */
  listingTypeKey: string | null;
  /** `ratingAverage`. */
  ratingValue: number | null;
  /** `reviewCount`, which Airbnb sends as a decimal string. */
  reviewCount: number | null;
  /** `isSuperhost`. */
  isSuperhost: boolean | null;
  /** `isNewListing`. */
  isNewListing: boolean | null;
}

/** One response, parsed. */
export interface HostListingsPage {
  listings: ProfileListing[];
  /**
   * What in the response `ProfileListing` has no place for: an unknown
   * field, or a value of an unexpected type. Empty when every field was
   * kept. The caller stores the response verbatim when this isn't empty.
   */
  unrecognized: string[];
}

/** Each field an entry may carry, and how it is read. */
const FIELDS: Record<string, (value: unknown) => { ok: boolean; value?: unknown }> = {
  __typename: (v) => ({ ok: v === 'BeehiveListing' }),
  id: (v) => ({ ok: typeof v === 'string' && /^\d+$/.test(v), value: v }),
  nameOrPlaceholderName: stringOrNull,
  pictureUrl: stringOrNull,
  propertyTypeName: stringOrNull,
  localizedRoomType: stringOrNull,
  roomTypeCategory: stringOrNull,
  ratingAverage: (v) => ({ ok: v === null || typeof v === 'number', value: v }),
  reviewCount: (v) =>
    v === null
      ? { ok: true, value: null }
      : { ok: typeof v === 'string' && /^\d+$/.test(v), value: Number(v) },
  isSuperhost: booleanOrNull,
  isNewListing: booleanOrNull,
};

function stringOrNull(v: unknown): { ok: boolean; value?: unknown } {
  return { ok: v === null || typeof v === 'string', value: v };
}

function booleanOrNull(v: unknown): { ok: boolean; value?: unknown } {
  return { ok: v === null || typeof v === 'boolean', value: v };
}

interface HostListingsResponse {
  errors?: Array<{ message?: string }>;
  data?: {
    beehive?: {
      getListOfListings?: {
        listings?: Array<Record<string, unknown>>;
      };
    };
  };
}

/**
 * One response body's listings, in Airbnb's order. Throws if the body isn't
 * JSON, carries GraphQL errors, has no listing list, or has an entry without
 * a listing id: without those the caller can't tell how many listings the
 * page held, so it can't page. Anything else it doesn't recognize is
 * reported in `unrecognized` rather than thrown.
 */
export function parseHostListingsPage(body: string, hostId: string): HostListingsPage {
  let data: HostListingsResponse;
  try {
    data = JSON.parse(body) as HostListingsResponse;
  } catch {
    throw new Error(`profile listings response for host ${hostId} is not JSON: ${body.slice(0, 200)}`);
  }
  if (data.errors?.length) {
    const messages = data.errors.map((error) => error.message ?? '?').join('; ');
    throw new Error(`profile listings query for host ${hostId} returned errors: ${messages}`);
  }
  const entries = data.data?.beehive?.getListOfListings?.listings;
  if (!Array.isArray(entries)) {
    throw new Error(`profile listings response for host ${hostId} has no listings list`);
  }

  const unrecognized = new Set<string>();
  // Keys around the list, so a new one (a total count, say) is not dropped.
  // `extensions` holds only a per-request trace id.
  const envelope: Array<[string, unknown, readonly string[]]> = [
    ['response', data, ['data', 'extensions']],
    ['data', data.data, ['beehive']],
    ['beehive', data.data?.beehive, ['__typename', 'getListOfListings']],
    ['getListOfListings', data.data?.beehive?.getListOfListings, ['__typename', 'listings']],
  ];
  for (const [where, object, known] of envelope) {
    for (const key of Object.keys(object as object)) {
      if (!known.includes(key)) unrecognized.add(`unknown field ${where}.${key}`);
    }
  }

  const listings = entries.map((entry): ProfileListing => {
    const id = entry?.id;
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new Error(`a profile listing for host ${hostId} has no listing id`);
    }
    const read: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      const field = FIELDS[key];
      const result = field?.(value);
      if (!result?.ok) {
        unrecognized.add(field ? `${key}: ${JSON.stringify(value)?.slice(0, 80)}` : `unknown field ${key}`);
      } else {
        read[key] = result.value;
      }
    }
    const value = <T>(key: string): T | null => (read[key] ?? null) as T | null;
    return {
      listingId: id,
      name: value('nameOrPlaceholderName'),
      photoUrl: value('pictureUrl'),
      buildingType: value('propertyTypeName'),
      listingType: value('localizedRoomType'),
      listingTypeKey: value('roomTypeCategory'),
      ratingValue: value('ratingAverage'),
      reviewCount: value('reviewCount'),
      isSuperhost: value('isSuperhost'),
      isNewListing: value('isNewListing'),
    };
  });
  return { listings, unrecognized: [...unrecognized].sort() };
}
