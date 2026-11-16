/**
 * The geocoding pass: after a scrape writes its page reads, geocode the
 * addresses of licenses in `licenses` that have no geocode yet, place each
 * match in a community council. Like the page reads, every request comes
 * first, then one transaction writes `muni_address_geocodes`.
 *
 * The council is found when the address is geocoded, against the council
 * polygons fetched that scrape, and stored on the geocode, so the views need no
 * spatial extension (the browser viewer's DuckDB would have to load one).
 */

import type { Database } from '@anchorage-str-db/db/database';
import { councilAt, fetchCommunityCouncils, type CouncilPolygon } from '@anchorage-str-db/muni-gis-client/councils';
import {
  geocodeAddresses,
  isAddressMatch,
  type GeocodeOne,
} from '@anchorage-str-db/muni-gis-client/geocoder';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { log } from '@anchorage-str-db/utils/log';

import { addressesToGeocode, recordGeocodes, type AddressGeocodeRow } from './store.ts';

/**
 * Milliseconds in a scrape during which addresses are geocoded. About 3,000
 * licenses have an address (2,237 distinct among the 2,480 read by
 * 2026-09-28). At the geocoder's 4 requests a second, this budget covers up to
 * about 2,400 addresses.
 */
export const GEOCODE_BUDGET_MS = 10 * 60_000;

/** Days before an address the geocoder could not match is asked about again. */
export const GEOCODE_MISS_RETRY_DAYS = 90;

/** The Muni GIS services, injectable for tests. */
export interface GisClients {
  geocodeOne?: GeocodeOne;
  fetchCouncils?: () => Promise<CouncilPolygon[]>;
}

export interface GeocodePassOptions extends GisClients {
  /** Milliseconds before no further address is sent; `GEOCODE_BUDGET_MS` by default. */
  budgetMs?: number;
}

export interface GeocodePassStats {
  addressesAttempted: number;
  /** Placed by the geocoder at the address itself. */
  addressesMatched: number;
  /** Answered without a match: no candidate, or only the street. */
  addressesUnmatched: number;
  /** Requests that failed; nothing is written for them. */
  addressesFailed: number;
  /** Matched addresses outside every community council. */
  matchedWithoutCouncil: number;
}

export async function runGeocodePass(
  db: Database,
  scrapeDate: IsoDate,
  options: GeocodePassOptions = {},
): Promise<GeocodePassStats> {
  // ---- network phase -----------------------------------------------------
  const addresses = await addressesToGeocode(db, addDays(scrapeDate, -GEOCODE_MISS_RETRY_DAYS));
  const geocodes: AddressGeocodeRow[] = [];
  let attempted = 0;
  let failed = 0;
  let withoutCouncil = 0;
  if (addresses.length) {
    log.info(`${addresses.length} license addresses to geocode, within the budget`);
    const councils = await (options.fetchCouncils ?? fetchCommunityCouncils)();
    const results = await geocodeAddresses(addresses, {
      ...(options.geocodeOne ? { geocodeOne: options.geocodeOne } : {}),
      budgetMs: options.budgetMs ?? GEOCODE_BUDGET_MS,
    });
    attempted = results.length;
    for (const { address, candidate, error } of results) {
      if (error !== null) {
        failed += 1;
        continue;
      }
      const match = candidate !== null && isAddressMatch(candidate) ? candidate : null;
      const council = match ? councilAt(councils, match.lat, match.lng) : null;
      if (match && council === null) withoutCouncil += 1;
      geocodes.push({
        address,
        geocodedDate: scrapeDate,
        matchedAddress: match?.matchedAddress ?? null,
        lat: match?.lat ?? null,
        lng: match?.lng ?? null,
        communityCouncil: council,
        score: candidate?.score ?? null,
        matchType: candidate?.matchType ?? null,
      });
    }
  }
  const matched = geocodes.filter((g) => g.matchedAddress !== null).length;
  log.info(
    `geocodes: ${matched} matched, ${geocodes.length - matched} unmatched, ${failed} failed` +
      (withoutCouncil ? `; ${withoutCouncil} matches in no community council` : ''),
  );

  // ---- write phase -------------------------------------------------------
  await db.transaction(() => recordGeocodes(db, geocodes));

  return {
    addressesAttempted: attempted,
    addressesMatched: matched,
    addressesUnmatched: geocodes.length - matched,
    addressesFailed: failed,
    matchedWithoutCouncil: withoutCouncil,
  };
}
