/**
 * Parcel `Property_Type` from the Muni's `PropertyInformation_Hosted` layer,
 * by parcel id.
 *
 * `Property_Type` is the assessor's category, in capitals: `RESIDENTIAL`,
 * `CONDO`, `APARTMENT`, `COMMERCIAL`, `INDUSTRIAL`, `MOBILE HOME`,
 * `MH PARK`, `VACANT LAND`, `OTHER`, or NULL (2026-11-10). It is not the
 * archived registration layer's `ParcelType` (`Residential`, `Commercial`):
 * of 400 sampled registrations, 51 the layer called `Commercial` are on a
 * `RESIDENTIAL` parcel.
 *
 * The layer has ~99,800 rows for ~98,600 parcel ids; the repeats carry the
 * same `Property_Type` in every case sampled, and the first is kept. A query
 * is a GET with the ids in its `where`, and ArcGIS Online answers 404 to a
 * URL much past 2 KB, so ids go `BATCH_SIZE` at a time.
 */

import { liveMuniArcgisFetcher, MUNI_ARCGIS_SERVICES, type FetchJson } from './arcgis.ts';

export const PROPERTY_INFORMATION_URL = `${MUNI_ARCGIS_SERVICES}/PropertyInformation_Hosted/FeatureServer/0`;

/** Parcel ids per query: 50 eleven-digit ids make a ~1.3 KB URL. */
export const BATCH_SIZE = 50;

/** A parcel id the layer was asked about. */
export interface ParcelPropertyType {
  parcelId: string;
  /** Whether the layer has a row for the parcel id. */
  found: boolean;
  /** NULL when the layer has no row, or a row with no `Property_Type`. */
  propertyType: string | null;
}

/** A parcel id as the license page shows it: digits only. Anything else would break the `where`. */
const PARCEL_ID = /^\d+$/;

/**
 * The `Property_Type` of each parcel id, in input order, deduplicated. Ids
 * that are not all digits are left out. Throws when a query fails.
 */
export async function fetchPropertyTypes(
  parcelIds: readonly string[],
  fetchJson: FetchJson = liveMuniArcgisFetcher(),
): Promise<ParcelPropertyType[]> {
  const ids = [...new Set(parcelIds)].filter((id) => PARCEL_ID.test(id));
  const types = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const batch = ids.slice(start, start + BATCH_SIZE);
    const params = new URLSearchParams({
      where: `Parcel_ID IN (${batch.map((id) => `'${id}'`).join(',')})`,
      outFields: 'Parcel_ID,Property_Type',
      orderByFields: 'OBJECTID ASC',
      returnGeometry: 'false',
      f: 'json',
    });
    const body = (await fetchJson(`${PROPERTY_INFORMATION_URL}/query?${params}`)) as {
      features?: { attributes?: { Parcel_ID?: unknown; Property_Type?: unknown } }[];
      exceededTransferLimit?: boolean;
    };
    if (!Array.isArray(body.features)) throw new Error(`${PROPERTY_INFORMATION_URL}: a query returned no features array`);
    if (body.exceededTransferLimit) throw new Error(`${PROPERTY_INFORMATION_URL}: a batch of ${batch.length} ids exceeded the transfer limit`);
    for (const { attributes } of body.features) {
      const id = attributes?.Parcel_ID;
      if (typeof id !== 'string' || types.has(id)) continue;
      const type = attributes?.Property_Type;
      types.set(id, typeof type === 'string' ? type : null);
    }
  }
  return ids.map((parcelId) => ({
    parcelId,
    found: types.has(parcelId),
    propertyType: types.get(parcelId) ?? null,
  }));
}
