/**
 * The Muni's address geocoder, `MOA_Multirole_Locator`, the same locator the
 * Municipal Clerk's registration layer was geocoded with.
 *
 * `findAddressCandidates` takes one address as `SingleLine` and returns its
 * best candidate: the address as the locator writes it
 * (`525 W 3rd Ave, #501, Anchorage, AK, 99501`), a WGS84 coordinate, a score
 * from 0 to 100 and an `Addr_type`. The locator returns nothing scoring below
 * its own `MinimumMatchScore` of 90, and an empty list for an address it
 * cannot place, so a request for an unknown address is not an error.
 *
 * A candidate is a match only when it places the address itself
 * (`isAddressMatch`). The locator also answers with the street alone
 * (`Addr_type` `StreetName`), at score 100 for `Echo Ridge Dr, Girdwood` and
 * 95.63 for a house number the street does not have, and with intersections;
 * those are candidates but not matches.
 *
 * Measured against the archived registration layer (2026-11-10, 410
 * registered addresses): every candidate was `PointAddress` or `Subaddress`,
 * scored 96.67 or more, and lay a median 13 m and at most 80 m from the
 * layer's geocoded coordinate. The 12 addresses the layer could not match
 * (`311 MELODY PL`, with no city) all matched. 14 the layer matched got no
 * candidate: 8 in the parcel-address style `Unit:COND 29`, which
 * `geocoderQuery` rewrites, and 6 with a room or a repeated street typed
 * after the address.
 */

import { mapWithinBudget } from '@anchorage-str-db/utils/concurrency';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { Pacer } from '@anchorage-str-db/utils/pace';

import { liveJsonFetcher, type FetchJson } from './arcgis.ts';

export const GEOCODER_URL =
  'https://www.ancgis.com/arcgis/rest/services/Locators/MOA_Multirole_Locator/GeocodeServer/findAddressCandidates';

/** The lowest score that is a match: the locator's own `MinimumMatchScore`. */
export const MIN_MATCH_SCORE = 90;

/**
 * `Addr_type`s that place the address itself: a point address, a unit
 * within one, or a house number interpolated along a street's range.
 */
export const ADDRESS_MATCH_TYPES: readonly string[] = ['PointAddress', 'Subaddress', 'StreetAddress'];

/** The locator's best candidate for an address. */
export interface GeocodeCandidate {
  /** The address as the locator writes it. */
  matchedAddress: string;
  lat: number;
  lng: number;
  score: number;
  /** The locator's `Addr_type`: `PointAddress`, `Subaddress`, `StreetName`, ... */
  matchType: string | null;
}

/** Whether a candidate places the address itself, rather than only its street. */
export function isAddressMatch(candidate: GeocodeCandidate): boolean {
  return (
    candidate.score >= MIN_MATCH_SCORE &&
    candidate.matchType !== null &&
    ADDRESS_MATCH_TYPES.includes(candidate.matchType)
  );
}

/**
 * The text sent as `SingleLine`. The Muni's parcel-address style writes a
 * unit as `Unit:COND 29`, which the locator cannot read; without `Unit:` it
 * matches the unit (`5500 Alora Loop, #29`).
 */
export function geocoderQuery(address: string): string {
  return address.replace(/\bUnit:\s*/gi, '');
}

export function geocoderUrl(address: string): string {
  return `${GEOCODER_URL}?${new URLSearchParams({
    SingleLine: geocoderQuery(address),
    outFields: 'Addr_type',
    outSR: '4326',
    maxLocations: '1',
    f: 'json',
  })}`;
}

/** The best candidate in a `findAddressCandidates` response, or null when it has none. */
export function parseGeocodeResponse(body: unknown): GeocodeCandidate | null {
  const candidates = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error(`the geocoder's response has no candidates list: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const best = candidates[0] as
    | {
        address?: unknown;
        location?: { x?: unknown; y?: unknown };
        score?: unknown;
        attributes?: { Addr_type?: unknown };
      }
    | undefined;
  if (best === undefined) return null;
  const { address, location, score } = best;
  if (
    typeof address !== 'string' ||
    typeof location?.x !== 'number' ||
    typeof location.y !== 'number' ||
    typeof score !== 'number'
  ) {
    throw new Error(`a geocoder candidate without an address, coordinate or score: ${JSON.stringify(best).slice(0, 200)}`);
  }
  const matchType = best.attributes?.Addr_type;
  return {
    matchedAddress: address,
    lat: location.y,
    lng: location.x,
    score,
    matchType: typeof matchType === 'string' ? matchType : null,
  };
}

/** One address's best candidate, or null when the locator has none. */
export type GeocodeOne = (address: string) => Promise<GeocodeCandidate | null>;

/**
 * Request tuning. The locator answers in ~0.25 s; 4/s keeps about one
 * request in flight.
 */
const REQUESTS_PER_SECOND = 4;
const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 500;

function geocoderPacer(): Pacer {
  return new Pacer({ rate: REQUESTS_PER_SECOND, service: 'the Muni geocoder' });
}

/** Real requests, paced by one `Pacer` and retried. */
export function liveGeocoder(pacer = geocoderPacer()): GeocodeOne {
  const fetchJson: FetchJson = liveJsonFetcher({
    pacer,
    timeoutMs: TIMEOUT_MS,
    attempts: MAX_RETRIES,
    backoffMs: RETRY_BACKOFF_MS,
  });
  return async (address) => parseGeocodeResponse(await fetchJson(geocoderUrl(address)));
}

/** An address's best candidate (null for none), or the error when the request failed. */
export type GeocodeResult =
  | { address: string; candidate: GeocodeCandidate | null; error: null }
  | { address: string; candidate: null; error: string };

export interface GeocodeAddressesOptions {
  geocodeOne?: GeocodeOne;
  concurrency?: number;
  /** No address is sent once this many milliseconds have passed. Unlimited by default. */
  budgetMs?: number;
}

/**
 * Geocode the addresses in the order given, until `budgetMs` is spent. A
 * failed request is recorded in its result rather than thrown. Addresses not
 * reached in the budget have no result.
 */
export async function geocodeAddresses(
  addresses: readonly string[],
  options: GeocodeAddressesOptions = {},
): Promise<GeocodeResult[]> {
  const geocodeOne = options.geocodeOne ?? liveGeocoder();
  const results = await mapWithinBudget(
    addresses,
    options.concurrency ?? CONCURRENCY,
    options.budgetMs ?? Infinity,
    async (address): Promise<GeocodeResult> => {
      try {
        return { address, candidate: await geocodeOne(address), error: null };
      } catch (err) {
        return { address, candidate: null, error: describeError(rootCause(err)) };
      }
    },
  );
  for (const result of results) {
    if (result.error) log.warn(`geocoding ${JSON.stringify(result.address)} failed: ${result.error}`);
  }
  return results;
}
