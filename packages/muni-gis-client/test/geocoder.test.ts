import { describe, expect, it } from 'vitest';

import {
  geocodeAddresses,
  geocoderQuery,
  geocoderUrl,
  isAddressMatch,
  liveGeocoder,
  parseGeocodeResponse,
  type GeocodeCandidate,
} from '../src/geocoder.ts';

/** The locator's response for `525 w 3rd Ave #501, anchorage AK 99501`, 2026-11-10. */
const SUBADDRESS = {
  spatialReference: { wkid: 4326, latestWkid: 4326 },
  candidates: [
    {
      address: '525 W 3rd Ave, #501, Anchorage, AK, 99501',
      location: { x: -149.892467111362, y: 61.219642109028 },
      score: 100,
      attributes: { Addr_type: 'Subaddress' },
      extent: { xmin: -149.893467111362, ymin: 61.218642109028, xmax: -149.891467111362, ymax: 61.220642109028 },
    },
  ],
};

const candidate = (overrides: Partial<GeocodeCandidate>): GeocodeCandidate => ({
  matchedAddress: 'Echo Ridge Dr, Girdwood, AK, 99587',
  lat: 60.95,
  lng: -149.12,
  score: 100,
  matchType: 'PointAddress',
  ...overrides,
});

describe('parseGeocodeResponse', () => {
  it('reads the best candidate', () => {
    expect(parseGeocodeResponse(SUBADDRESS)).toEqual({
      matchedAddress: '525 W 3rd Ave, #501, Anchorage, AK, 99501',
      lat: 61.219642109028,
      lng: -149.892467111362,
      score: 100,
      matchType: 'Subaddress',
    });
  });

  it('is null when the locator has no candidate', () => {
    expect(parseGeocodeResponse({ spatialReference: { wkid: 4326 }, candidates: [] })).toBeNull();
  });

  it('throws on a response that is not a candidates list', () => {
    expect(() => parseGeocodeResponse({ error: { code: 500 } })).toThrow(/no candidates list/);
  });
});

describe('isAddressMatch', () => {
  it('takes a point address, a unit or an interpolated house number', () => {
    expect(isAddressMatch(candidate({ matchType: 'PointAddress' }))).toBe(true);
    expect(isAddressMatch(candidate({ matchType: 'Subaddress', score: 99.6 }))).toBe(true);
    expect(isAddressMatch(candidate({ matchType: 'StreetAddress', score: 95 }))).toBe(true);
  });

  it('rejects the street alone, an intersection, and a score below 90', () => {
    expect(isAddressMatch(candidate({ matchType: 'StreetName' }))).toBe(false);
    expect(isAddressMatch(candidate({ matchType: 'StreetInt' }))).toBe(false);
    expect(isAddressMatch(candidate({ matchType: 'PointAddress', score: 89.9 }))).toBe(false);
    expect(isAddressMatch(candidate({ matchType: null }))).toBe(false);
  });
});

describe('geocoderQuery', () => {
  it("drops the parcel-address style's Unit: prefix", () => {
    expect(geocoderQuery('5500 ALORA LOOP, Unit:COND 29, ANCHORAGE, AK 99504')).toBe(
      '5500 ALORA LOOP, COND 29, ANCHORAGE, AK 99504',
    );
    expect(geocoderQuery('525 w 3rd Ave #501, anchorage AK 99501')).toBe('525 w 3rd Ave #501, anchorage AK 99501');
  });

  it('asks for one WGS84 candidate with its Addr_type', () => {
    const params = new URL(geocoderUrl('311 MELODY PL')).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      SingleLine: '311 MELODY PL',
      outFields: 'Addr_type',
      outSR: '4326',
      maxLocations: '1',
      f: 'json',
    });
  });
});

describe('geocodeAddresses', () => {
  it('records a failed request in its result', async () => {
    const results = await geocodeAddresses(['311 MELODY PL', 'boom'], {
      geocodeOne: async (address) => {
        if (address === 'boom') throw new Error('HTTP 500');
        return candidate({});
      },
    });

    expect(results.map((r) => [r.address, r.candidate?.matchType ?? null, r.error])).toEqual([
      ['311 MELODY PL', 'PointAddress', null],
      ['boom', null, 'Error: HTTP 500'],
    ]);
  });
});

describe('the live locator', () => {
  const geocode = liveGeocoder();

  it('matches a typed address, a parcel address and one with no city', async () => {
    const typed = await geocode('525 w 3rd Ave #501, anchorage AK 99501');
    const parcel = await geocode('257 ECHO RIDGE DR, GIRDWOOD, AK 99587');
    const noCity = await geocode('311 MELODY PL');

    expect(typed).toMatchObject({ matchedAddress: '525 W 3rd Ave, #501, Anchorage, AK, 99501', matchType: 'Subaddress' });
    expect(parcel).toMatchObject({ matchedAddress: '257 Echo Ridge Dr, Girdwood, AK, 99587', matchType: 'PointAddress' });
    expect(noCity).toMatchObject({ matchedAddress: '311 Melody Pl, Anchorage, AK, 99504', matchType: 'PointAddress' });
    for (const c of [typed, parcel, noCity]) expect(isAddressMatch(c!)).toBe(true);
    expect(parcel!.lat).toBeCloseTo(60.9515, 3);
    expect(parcel!.lng).toBeCloseTo(-149.1206, 3);
  });

  it('places a unit in the Unit: style, and only the street for a missing house number', async () => {
    const unit = await geocode('5500 ALORA LOOP, Unit:COND 29, ANCHORAGE, AK 99504');
    const street = await geocode('999 Echo Ridge Dr, Girdwood AK');

    expect(unit).toMatchObject({ matchedAddress: '5500 Alora Loop, #29, Anchorage, AK, 99504', matchType: 'Subaddress' });
    expect(street?.matchType).toBe('StreetName');
    expect(isAddressMatch(street!)).toBe(false);
  });

  it('has no candidate for an address it cannot place', async () => {
    expect(await geocode('1234 Nonexistent Street, Anchorage')).toBeNull();
  });
});
