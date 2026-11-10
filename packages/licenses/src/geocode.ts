/**
 * The geocoding pass: after a scan writes its page reads, geocode the
 * addresses of licenses in `licenses` that have no geocode yet, place each
 * match in a community council, and read the `Property_Type` of their parcel
 * ids. Like the page reads, every request comes first, then one transaction
 * writes `muni_address_geocodes` and `muni_parcel_types`.
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
import { BATCH_SIZE, fetchPropertyTypes, type ParcelPropertyType } from '@anchorage-str-db/muni-gis/parcels';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';

import {
  addressesToGeocode,
  parcelIdsToRead,
  recordGisReads,
  type AddressGeocodeRow,
  type ParcelTypeRow,
} from './store.ts';

/**
 * Addresses geocoded per scan. About 3,000 licenses have an address (2,237
 * distinct among the 2,480 read by 2026-09-28), so the first scans spread
 * them over three days; at the geocoder's 4 requests a second, 1000 take
 * about four minutes.
 */
export const MAX_GEOCODES_PER_SCAN = 1000;

/** Days before an address the geocoder could not match is asked about again. */
export const GEOCODE_MISS_RETRY_DAYS = 90;

/** Parcel ids read per scan, 50 to a request. */
export const MAX_PARCEL_READS_PER_SCAN = 3000;

/** Days before a parcel's `Property_Type` is read again. */
export const PARCEL_TYPE_REFRESH_DAYS = 90;

/** The Muni GIS services, injectable for tests. */
export interface GisClients {
  geocodeOne?: GeocodeOne;
  fetchCouncils?: () => Promise<CouncilPolygon[]>;
  /** One query's worth of parcel ids, at most `BATCH_SIZE`. */
  fetchPropertyTypes?: (parcelIds: readonly string[]) => Promise<ParcelPropertyType[]>;
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
  parcelsAttempted: number;
  parcelsFailed: number;
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

  const parcelIds = await parcelIdsToRead(
    db,
    addDays(scrapeDate, -PARCEL_TYPE_REFRESH_DAYS),
    MAX_PARCEL_READS_PER_SCAN,
  );
  const parcelTypes: ParcelTypeRow[] = [];
  let parcelsFailed = 0;
  const fetchBatch = options.fetchPropertyTypes ?? ((ids: readonly string[]) => fetchPropertyTypes(ids));
  for (let start = 0; start < parcelIds.length; start += BATCH_SIZE) {
    const batch = parcelIds.slice(start, start + BATCH_SIZE);
    try {
      for (const { parcelId, found, propertyType } of await fetchBatch(batch)) {
        parcelTypes.push({ parcelId, readDate: scrapeDate, inLayer: found, propertyType });
      }
    } catch (err) {
      parcelsFailed += batch.length;
      log.warn(`reading ${batch.length} parcel types failed: ${describeError(rootCause(err))}`);
    }
  }
  if (parcelIds.length) {
    log.info(
      `parcel types: ${parcelTypes.length} read of ${parcelIds.length}, ` +
        `${parcelTypes.filter((p) => !p.inLayer).length} not in the property layer`,
    );
  }

  // ---- write phase -------------------------------------------------------
  await db.transaction(() => recordGisReads(db, geocodes, parcelTypes));

  return {
    addressesAttempted: addresses.length,
    addressesMatched: matched,
    addressesUnmatched: geocodes.length - matched,
    addressesFailed: failed,
    matchedWithoutCouncil: withoutCouncil,
    parcelsAttempted: parcelIds.length,
    parcelsFailed,
  };
}
