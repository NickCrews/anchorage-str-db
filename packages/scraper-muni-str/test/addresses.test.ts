/**
 * Reads the live registration layer and checks how its address fields
 * relate: `Location` is the address on the license, and `GeocodedAddress`,
 * the point, `CommunityCouncil` and `ParcelType` are derived from it by the
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

function registration(number: string): Registration {
  const found = registrations.find((r) => r.registrationNumber === number);
  if (!found) throw new Error(`${number} is not in the layer`);
  return found;
}

beforeAll(async () => {
  ({ registrations } = await fetchRegistrations());
});

describe('address fields in the live registration layer', () => {
  it('gives every unmatched location, all lacking a city or zip, the placeholder point and no council or parcel type', () => {
    const unmatched = registrations.filter((r) => r.geocodedAddress === NO_MATCH_GEOCODED_ADDRESS);

    expect(unmatched.length).toBeGreaterThan(0);
    for (const r of unmatched) {
      expect(r.location, r.registrationNumber).not.toMatch(/,|\bAK\b|\d{5}$/);
      expect([r.geocodedLng, r.geocodedLat], r.registrationNumber).toEqual([
        NO_MATCH_POINT.lng,
        NO_MATCH_POINT.lat,
      ]);
      expect([r.communityCouncil, r.parcelType], r.registrationNumber).toEqual([null, null]);
    }
  });

  it('has a community council exactly when the geocoder matched the location', () => {
    const mismatched = registrations.filter(
      (r) => (r.communityCouncil === null) !== (r.geocodedAddress === NO_MATCH_GEOCODED_ADDRESS),
    );

    expect(mismatched.map((r) => r.registrationNumber)).toEqual([]);
  });

  it('keeps a property record address as location, with the geocoder reading beside it', () => {
    expect(registration('STR20260309')).toMatchObject({
      location: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587',
      geocodedAddress: '257 Echo Ridge Dr, Girdwood, Alaska, 99587',
      communityCouncil: 'Girdwood',
      parcelType: 'Residential',
    });
  });

  it('keeps typed text as location, which the geocoder rewrites', () => {
    expect(registration('STR20260057')).toMatchObject({
      location: '525 w 3rd Ave #501, anchorage AK 99501',
      geocodedAddress: '525 W 3rd Ave, Apartment 501, Anchorage, Alaska, 99501',
    });
    expect(registration('STR20262410')).toMatchObject({
      location: '4425 E 6TH AVE ANCHORAGE ALASKA, 99508, ROOM 4, ANCHORAGE AK 99508',
      geocodedAddress: '4425 E 6th Ave, Anchorage, Alaska, 99508',
    });
    expect(registration('STR20260352')).toMatchObject({
      location: "2955 WENDY'S WAY, ANCHORAGE, AK 99517",
      geocodedAddress: '2955 Wendys Way, Anchorage, Alaska, 99517',
    });
  });

  it('can lack a parcel type for an address that geocoded', () => {
    expect(registration('STR20260110')).toMatchObject({
      location: '7821 MAYFAIR DR, Unit:APT C, ANCHORAGE, AK 99502',
      geocodedAddress: '7821 Mayfair Dr, Apartment C, Anchorage, Alaska, 99502',
      communityCouncil: 'Sand Lake',
      parcelType: null,
    });
  });

  it('does not match a street-only location', () => {
    expect(registration('STR20260126')).toMatchObject({
      location: '311 MELODY PL',
      geocodedAddress: NO_MATCH_GEOCODED_ADDRESS,
      communityCouncil: null,
    });
  });
});
