/**
 * Reads the live registration layer and checks how its address fields
 * relate: `Location` is the address on the license, and `GeocodedAddress`,
 * the coordinate, `CommunityCouncil` and `ParcelType` are derived from it by the
 * Muni. `packages/scraper/test/addressProvenance.test.ts` checks `Location`
 * against the license pages.
 *
 * The rules are checked across every registration; the examples are
 * registrations as published on 2026-09-07. A failing example can also mean
 * the Muni edited that registration.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  fetchRegistrations,
  NO_MATCH_GEOCODED_ADDRESS,
  NO_MATCH_POINT,
  type Registration,
} from '../src/registrationLayers.ts';

let registrations: Registration[];

function registration(registrationId: string): Registration {
  const found = registrations.find((r) => r.registrationId === registrationId);
  if (!found) throw new Error(`${registrationId} is not in the layer`);
  return found;
}

beforeAll(async () => {
  ({ registrations } = await fetchRegistrations());
});

describe('address fields in the live registration layer', () => {
  it('gives every unmatched address, all lacking a city or zip, the placeholder coordinate and no council or parcel type', () => {
    const unmatched = registrations.filter((r) => r.geocodedAddress === NO_MATCH_GEOCODED_ADDRESS);

    expect(unmatched.length).toBeGreaterThan(0);
    for (const r of unmatched) {
      expect(r.registeredAddress, r.registrationId).not.toMatch(/,|\bAK\b|\d{5}$/);
      expect([r.geocodedLng, r.geocodedLat], r.registrationId).toEqual([
        NO_MATCH_POINT.lng,
        NO_MATCH_POINT.lat,
      ]);
      expect([r.communityCouncil, r.parcelType], r.registrationId).toEqual([null, null]);
    }
  });

  it('has a community council exactly when the geocoder matched the address', () => {
    const mismatched = registrations.filter(
      (r) => (r.communityCouncil === null) !== (r.geocodedAddress === NO_MATCH_GEOCODED_ADDRESS),
    );

    expect(mismatched.map((r) => r.registrationId)).toEqual([]);
  });

  it('keeps a property record address as registered_address, with the geocoder reading beside it', () => {
    expect(registration('STR20260309')).toMatchObject({
      registeredAddress: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587',
      geocodedAddress: '257 Echo Ridge Dr, Girdwood, Alaska, 99587',
      communityCouncil: 'Girdwood',
      parcelType: 'Residential',
    });
  });

  it('keeps typed text as registered_address, which the geocoder rewrites', () => {
    expect(registration('STR20260057')).toMatchObject({
      registeredAddress: '525 w 3rd Ave #501, anchorage AK 99501',
      geocodedAddress: '525 W 3rd Ave, Apartment 501, Anchorage, Alaska, 99501',
    });
    expect(registration('STR20262410')).toMatchObject({
      registeredAddress: '4425 E 6TH AVE ANCHORAGE ALASKA, 99508, ROOM 4, ANCHORAGE AK 99508',
      geocodedAddress: '4425 E 6th Ave, Anchorage, Alaska, 99508',
    });
    expect(registration('STR20260352')).toMatchObject({
      registeredAddress: "2955 WENDY'S WAY, ANCHORAGE, AK 99517",
      geocodedAddress: '2955 Wendys Way, Anchorage, Alaska, 99517',
    });
  });

  it('can lack a parcel type for an address that geocoded', () => {
    expect(registration('STR20260110')).toMatchObject({
      registeredAddress: '7821 MAYFAIR DR, Unit:APT C, ANCHORAGE, AK 99502',
      geocodedAddress: '7821 Mayfair Dr, Apartment C, Anchorage, Alaska, 99502',
      communityCouncil: 'Sand Lake',
      parcelType: null,
    });
  });

  it('does not match a street-only address', () => {
    expect(registration('STR20260126')).toMatchObject({
      registeredAddress: '311 MELODY PL',
      geocodedAddress: NO_MATCH_GEOCODED_ADDRESS,
      communityCouncil: null,
    });
  });
});
