/**
 * Reads the real registration layer from ArcGIS Online. The layer's schema
 * and paging are the risk, so these tests use no saved or synthetic
 * responses: when the Muni changes the layer, they fail.
 *
 * Expected registrations are the layer's contents on 2026-09-13. A failure on
 * a single field can also mean the registrant changed their registration;
 * query the layer to tell which.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  fetchRegistrations,
  cityviewLicenseIdFromStatusUrl,
  NO_MATCH_GEOCODED_ADDRESS,
  PAGE_SIZE,
  toRegistration,
  type Registration,
  type RegistrationLayer,
} from '../src/registrationLayers.ts';

/** `YYYY-MM-DD HH:MM:SS`, naive UTC. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe('fetchRegistrations on the live layer', () => {
  let layer: RegistrationLayer;
  const byRegistrationId = new Map<string, Registration>();

  beforeAll(async () => {
    layer = await fetchRegistrations();
    for (const registration of layer.registrations) {
      byRegistrationId.set(registration.registrationId, registration);
    }
  });

  it('reads every feature across more than one page', () => {
    // fetchLayer throws unless the pages add up to the server's count, so
    // a layer larger than one page shows the offset paging is complete.
    expect(layer.registrations.length).toBeGreaterThan(PAGE_SIZE);
    expect(byRegistrationId.size).toBe(layer.registrations.length);
  });

  it("reads the layer's data edit date", () => {
    expect(layer.dataEditedAt).toMatch(TIMESTAMP);
  });

  it('reads a geocoded registration with every field', () => {
    expect(byRegistrationId.get('STR20260309')).toEqual({
      registrationId: 'STR20260309',
      licenseId: 'LC260500349',
      submittedDate: '2026-05-03',
      issuedDate: '2026-05-04',
      expiresDate: '2027-04-30',
      registeredAddress: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587',
      businessName: 'Echo Ridge Mountain Retreat',
      status: 'Active',
      statusUrl: 'https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B',
      communityCouncil: 'Girdwood',
      parcelType: 'Residential',
      geocodedAddress: '257 Echo Ridge Dr, Girdwood, Alaska, 99587',
      geocodedLat: 60.951649114000986,
      geocodedLng: -149.120587580428,
      publishedAt: expect.stringMatching(TIMESTAMP),
    });
  });

  it("keeps 'None' and the placeholder point for an address the geocoder could not match", () => {
    expect(byRegistrationId.get('STR20260126')).toEqual({
      registrationId: 'STR20260126',
      licenseId: 'LC260500179',
      submittedDate: '2026-05-01',
      issuedDate: '2026-05-01',
      expiresDate: '2027-04-30',
      registeredAddress: '311 MELODY PL',
      businessName: 'None',
      status: 'Active',
      statusUrl: 'https://www.muni.org/CityViewPortal/License/Status?licenseId=13753&category=B',
      communityCouncil: null,
      parcelType: null,
      geocodedAddress: NO_MATCH_GEOCODED_ADDRESS,
      geocodedLat: 61.153442,
      geocodedLng: -150.20935,
      publishedAt: expect.stringMatching(TIMESTAMP),
    });
  });
});

describe('toRegistration', () => {
  it('rejects a feature with no registration id', () => {
    expect(() => toRegistration({ attributes: { OBJECTID: 1 } })).toThrow(/RegistrationNumber/);
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(() =>
      toRegistration({ attributes: { RegistrationNumber: 'STR20260001', Issued: '05/01/2026' } }),
    ).toThrow(/ISO/);
  });
});

describe('cityviewLicenseIdFromStatusUrl', () => {
  it('reads cityviewLicenseId from the query string', () => {
    expect(
      cityviewLicenseIdFromStatusUrl(
        'https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B',
      ),
    ).toBe(13923);
  });

  it('returns null for a missing or different URL', () => {
    expect(cityviewLicenseIdFromStatusUrl(null)).toBeNull();
    expect(cityviewLicenseIdFromStatusUrl('https://www.muni.org/CityViewPortal/')).toBeNull();
  });
});
