/**
 * The Municipal Clerk's short-term rental registration layer
 * (`Clerk_ShortTermRental_Reg`, one point per registration), published in the
 * "Short Term Rental Registration Viewer"
 * (https://experience.arcgis.com/experience/22b40a78a9fc459e9950a16249b37ed2).
 *
 * The layer has two kinds of address field. `Location` is the address on the
 * license, as the applicant gave it. The rest (`GeocodedAddress`, the point,
 * `CommunityCouncil`, `ParcelType`) the Muni derived from it afterwards.
 * `test/addresses.test.ts` checks this against the live layer.
 *
 * Values are kept as published. That includes the string `'None'` for a
 * missing business name, and a placeholder point for an address the Muni's
 * geocoder could not match (see `NO_MATCH_GEOCODED_ADDRESS`); the
 * `registrations` view cleans both.
 */

import { parseIsoDate, type IsoDate } from '@anchorage-str-db/utils/dates';
import { Pacer } from '@anchorage-str-db/utils/pace';

import {
  epochMsToTimestamp,
  fetchLayer,
  fetchLayerDataEditedAt,
  liveJsonFetcher,
  type ArcgisFeature,
  type FetchJson,
} from './arcgis.ts';

export const SERVICE_URL =
  'https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/ShortTermRental_Registrations_Hosted/FeatureServer';
export const REGISTRATIONS_LAYER_URL = `${SERVICE_URL}/0`;

/**
 * `GeocodedAddress` for a registration whose `Location` the geocoder could
 * not match: every one has no city or zip, including addresses taken from a
 * property record (`311 MELODY PL`). They all sit on one placeholder point,
 * `NO_MATCH_POINT`, and have no `CommunityCouncil` or `ParcelType`.
 */
export const NO_MATCH_GEOCODED_ADDRESS = 'Incomplete address provided. No Match.';
export const NO_MATCH_POINT = { lng: -150.20935, lat: 61.153442 } as const;

export interface Registration {
  /** `STR` + 8 digits, e.g. `STR20260309`. Airbnb's `str_registration_id`. */
  registrationNumber: string;
  /** `LC` + 9 digits: the license application, the page's "Licensee Number". */
  applicationNumber: string | null;
  submittedDate: IsoDate | null;
  issuedDate: IsoDate | null;
  expiresDate: IsoDate | null;
  /**
   * The address on the license: the same string as the license page's
   * location. For a license tied to a Muni property record it is that
   * record's address, in the Muni's parcel-address style
   * (`7730 MAYFAIR DR, Unit:APT 1, ANCHORAGE, AK 99502`, or `311 MELODY PL`
   * when the record has no city). Otherwise it is the text the applicant
   * typed (`525 w 3rd Ave #501, anchorage AK 99501`). The license page, not
   * this layer, shows which.
   */
  location: string | null;
  businessName: string | null;
  status: string | null;
  /** The CityView license page, `.../License/Status?licenseId=13923&category=B`. */
  statusUrl: string | null;
  /** The council containing the geocoded point; null exactly when geocoding found no match. */
  communityCouncil: string | null;
  /**
   * `Residential` or `Commercial`. Can be null for a license that names a
   * parcel and whose address geocoded (`7821 MAYFAIR DR, Unit:APT C`).
   */
  parcelType: string | null;
  /**
   * The Muni geocoder's reading of `location`, in the geocoder's own style
   * (`7821 Mayfair Dr, Apartment C, Anchorage, Alaska, 99502`). It rewrites
   * typed text too: `#501` becomes `Apartment 501`, `ROOM 4` is dropped,
   * `WENDY'S` becomes `Wendys`. A `location` without a city or zip gets
   * `NO_MATCH_GEOCODED_ADDRESS`.
   */
  geocodedAddress: string | null;
  /** The geocoded point, not a position the applicant gave. */
  geocodedLat: number | null;
  geocodedLng: number | null;
  /** The layer's `PUBDATE`, naive UTC. */
  publishedAt: string | null;
}

function text(attributes: Record<string, unknown>, field: string): string | null {
  const value = attributes[field];
  return typeof value === 'string' ? value : null;
}

/** An `esriFieldTypeDateOnly` value, which ArcGIS returns as `YYYY-MM-DD`. */
function dateOnly(attributes: Record<string, unknown>, field: string): IsoDate | null {
  const value = text(attributes, field);
  return value === null ? null : parseIsoDate(value);
}

/** Throws on a feature with no registration number, which could not be stored. */
export function toRegistration(feature: ArcgisFeature): Registration {
  const a = feature.attributes;
  const registrationNumber = text(a, 'RegistrationNumber');
  if (!registrationNumber) {
    throw new Error(`registration feature without a RegistrationNumber: ${JSON.stringify(a)}`);
  }
  return {
    registrationNumber,
    applicationNumber: text(a, 'ApplicationNumber'),
    submittedDate: dateOnly(a, 'Submitted'),
    issuedDate: dateOnly(a, 'Issued'),
    expiresDate: dateOnly(a, 'Expires'),
    location: text(a, 'Location'),
    businessName: text(a, 'BusinessName'),
    status: text(a, 'Status'),
    statusUrl: text(a, 'StatusUrl'),
    communityCouncil: text(a, 'CommunityCouncil'),
    parcelType: text(a, 'ParcelType'),
    geocodedAddress: text(a, 'GeocodedAddress'),
    geocodedLat: feature.geometry?.y ?? null,
    geocodedLng: feature.geometry?.x ?? null,
    publishedAt: epochMsToTimestamp(a['PUBDATE']),
  };
}

/** The CityView `licenseId` in a registration's `statusUrl`, or null. */
export function licenseIdFromStatusUrl(statusUrl: string | null): number | null {
  const match = statusUrl?.match(/[?&]licenseId=(\d+)/);
  return match ? Number(match[1]) : null;
}

export interface RegistrationLayer {
  registrations: Registration[];
  /** The registration layer's `editingInfo.dataLastEditDate`, naive UTC. */
  dataEditedAt: string | null;
}

/**
 * Request tuning. A run is a handful of requests, so the rate only spaces out
 * retries against ArcGIS Online.
 */
const REQUESTS_PER_SECOND = 2;
const TIMEOUT_MS = 60_000;

/** A failed layer query fails the run, so it gets more attempts than a page read. */
const MAX_RETRIES = 4;
const RETRY_BACKOFF_MS = 1500;

/** Features per query: the registration layers' `maxRecordCount`. */
export const PAGE_SIZE = 2000;

/**
 * Every registration. Throws if the layer can't be read in full: a partial
 * snapshot would read as registrations lapsing.
 */
export async function fetchRegistrations(
  fetchJson: FetchJson = liveJsonFetcher({
    pacer: new Pacer({ rate: REQUESTS_PER_SECOND, service: 'ArcGIS Online' }),
    timeoutMs: TIMEOUT_MS,
    attempts: MAX_RETRIES,
    backoffMs: RETRY_BACKOFF_MS,
  }),
): Promise<RegistrationLayer> {
  const dataEditedAt = await fetchLayerDataEditedAt(REGISTRATIONS_LAYER_URL, fetchJson);
  const registrationLayer = await fetchLayer(REGISTRATIONS_LAYER_URL, {
    fetchJson,
    pageSize: PAGE_SIZE,
    returnGeometry: true,
  });
  return {
    registrations: registrationLayer.features.map(toRegistration),
    dataEditedAt,
  };
}
