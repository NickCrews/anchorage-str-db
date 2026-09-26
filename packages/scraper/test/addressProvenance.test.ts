/**
 * Where a registration's address comes from, checked against both live Muni
 * sources: the ArcGIS registration layer and the CityView license pages.
 *
 * - A license tied to a Muni property record shows its parcel id and address
 *   as links to the portal's property search, and the layer's `Location` is
 *   that address.
 * - A license with no property record shows the registrant's typed text,
 *   unlinked, and `Location` is that text.
 * - The layer's geocoded fields are derived from `Location`, so a property
 *   record address can still fail to geocode, and a license with a parcel
 *   can still lack `ParcelType`.
 *
 * Examples are as published on 2026-09-07 (layer) and 2026-09-14 (pages). A
 * failure can also mean the Muni or a licensee edited that registration.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  fetchLicensePages,
  type LicenseLocation,
  type LicensePage,
} from '@anchorage-str-db/muni-licenses/licensePage';
import {
  fetchRegistrations,
  cityviewLicenseIdFromStatusUrl,
  NO_MATCH_GEOCODED_ADDRESS,
  type Registration,
} from '@anchorage-str-db/scraper-muni-str/registrationLayers';

const PROPERTY_SEARCH = 'https://www.muni.org/CityViewPortal/Property/PropertyReview?';

/** Registration id to CityView license id. */
const FROM_PROPERTY_RECORDS = {
  STR20260309: 13923, // 257 ECHO RIDGE DR
  STR20260428: 13640, // two parcels and an address
  STR20260046: 13613, // an address with no parcel
  STR20260110: 13731, // no ParcelType in the layer
  STR20260126: 13753, // 311 MELODY PL: no city, so no geocode
} as const;

/** A property record address whose label the portal replaced with its own lookup error. */
const LOOKUP_ERROR = { registrationId: 'STR20260352', cityviewLicenseId: 13966 } as const;

const TYPED_BY_REGISTRANT = {
  STR20262410: 15993,
  STR20260057: 13664,
} as const;

const registrations = new Map<string, Registration>();
const pages = new Map<number, LicensePage>();

beforeAll(async () => {
  const { registrations: all } = await fetchRegistrations();
  for (const r of all) registrations.set(r.registrationId, r);

  const ids = [
    ...Object.values(FROM_PROPERTY_RECORDS),
    ...Object.values(TYPED_BY_REGISTRANT),
    LOOKUP_ERROR.cityviewLicenseId,
  ];
  for (const result of await fetchLicensePages(ids)) {
    if (!result.page) throw new Error(`license ${result.cityviewLicenseId}: ${result.error}`);
    pages.set(result.cityviewLicenseId, result.page);
  }
});

function layer(registrationId: string): Registration {
  const found = registrations.get(registrationId);
  if (!found) throw new Error(`${registrationId} is not in the layer`);
  return found;
}

function linked(page: LicensePage, label: string): LicenseLocation[] {
  return page.locations.filter((l) => l.label === label && l.link?.startsWith(PROPERTY_SEARCH));
}

describe('registration addresses', () => {
  it.each(Object.entries(FROM_PROPERTY_RECORDS))(
    '%s: Location is the address the license page links to a property record',
    (registrationId, cityviewLicenseId) => {
      const registration = layer(registrationId);
      const page = pages.get(cityviewLicenseId)!;

      expect(cityviewLicenseIdFromStatusUrl(registration.statusUrl)).toBe(cityviewLicenseId);
      expect(linked(page, 'Address').map((l) => l.value)).toEqual([registration.registeredAddress]);
    },
  );

  it.each(Object.entries(TYPED_BY_REGISTRANT))(
    '%s: Location is the unlinked text on a license page with no property record',
    (registrationId, cityviewLicenseId) => {
      const registration = layer(registrationId);
      const page = pages.get(cityviewLicenseId)!;

      expect(cityviewLicenseIdFromStatusUrl(registration.statusUrl)).toBe(cityviewLicenseId);
      expect(page.locations.filter((l) => l.link !== null)).toEqual([]);
      expect(page.locations.map((l) => l.value)).toEqual([registration.registeredAddress]);
    },
  );

  it('keeps Location when the portal prints a lookup error in place of the label', () => {
    const page = pages.get(LOOKUP_ERROR.cityviewLicenseId)!;

    expect(page.locations).toEqual([
      {
        label: "Error: Syntax error: Missing operand after 'SWAY' operator.",
        value: layer(LOOKUP_ERROR.registrationId).registeredAddress,
        link: expect.stringMatching(/^https:\/\/www\.muni\.org\/CityViewPortal\/Property\/PropertyReview\?/),
      },
    ]);
  });

  it('can fail to geocode a property record address that has no city', () => {
    const page = pages.get(FROM_PROPERTY_RECORDS.STR20260126)!;

    expect(linked(page, 'Property').map((l) => l.value)).toEqual(['00606148000']);
    expect(linked(page, 'Address').map((l) => l.value)).toEqual(['311 MELODY PL']);
    expect(layer('STR20260126').geocodedAddress).toBe(NO_MATCH_GEOCODED_ADDRESS);
  });

  it('can lack ParcelType for a license that names its parcel', () => {
    const page = pages.get(FROM_PROPERTY_RECORDS.STR20260110)!;

    expect(linked(page, 'Property').map((l) => l.value)).toEqual(['01255110000']);
    expect(layer('STR20260110')).toMatchObject({
      parcelType: null,
      geocodedAddress: '7821 Mayfair Dr, Apartment C, Anchorage, Alaska, 99502',
    });
  });
});
