/**
 * The geocoding pass: after a scan writes its page reads, geocode the
 * addresses of licenses in `licenses` that have no geocode yet, place each
 * match in a community council. Like the page reads, every request comes
 * first, then one transaction writes `muni_address_geocodes`.
 *
 * The council is found when the address is geocoded, against the council
 * polygons fetched that scan, and stored on the geocode, so the views need no
 * spatial extension (the browser viewer's DuckDB would have to load one).
 */

import type { Database } from '@anchorage-str-db/db/database';
import { councilAt, fetchCommunityCouncils, type CouncilPolygon } from '@anchorage-str-db/muni-gis/councils';
import {
  geocodeAddresses,
  isAddressMatch,
  type GeocodeOne,
} from '@anchorage-str-db/muni-gis/geocoder';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { log } from '@anchorage-str-db/utils/log';

import { addressesToGeocode, recordGeocodes, type AddressGeocodeRow } from './store.ts';

/**
 * Addresses geocoded per scan. About 3,000 licenses have an address (2,237
 * distinct among the 2,480 read by 2026-09-28), so the first scans spread
 * them over three days; at the geocoder's 4 requests a second, 1000 take
 * about four minutes.
 */
export const MAX_GEOCODES_PER_SCAN = 1000;

/** Days before an address the geocoder could not match is asked about again. */
export const GEOCODE_MISS_RETRY_DAYS = 90;

/** The Muni GIS services, injectable for tests. */
export interface GisClients {
  geocodeOne?: GeocodeOne;
  fetchCouncils?: () => Promise<CouncilPolygon[]>;
}

export interface GeocodePassOptions extends GisClients {
  maxGeocodes?: number;
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
  const addresses = await addressesToGeocode(
    db,
    addDays(scrapeDate, -GEOCODE_MISS_RETRY_DAYS),
    options.maxGeocodes ?? MAX_GEOCODES_PER_SCAN,
  );
  const geocodes: AddressGeocodeRow[] = [];
  let failed = 0;
  let withoutCouncil = 0;
  if (addresses.length) {
    log.info(`geocoding ${addresses.length} license addresses`);
    const councils = await (options.fetchCouncils ?? fetchCommunityCouncils)();
    const results = await geocodeAddresses(addresses, options.geocodeOne ? { geocodeOne: options.geocodeOne } : {});
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
    addressesAttempted: addresses.length,
    addressesMatched: matched,
    addressesUnmatched: geocodes.length - matched,
    addressesFailed: failed,
    matchedWithoutCouncil: withoutCouncil,
  };
}
