/**
 * The identifier model CONTEXT.md rests on, checked against both live Muni
 * sources rather than assumed:
 *
 * - A registration, its license and that license's CityView page are one
 *   record under three numbering systems, one-to-one-to-one.
 * - `license_id` (`LC260500349`) identifies the license, not the licensee, so
 *   a business with four registrations has four of them. Nothing in either
 *   source identifies the licensee as a party.
 * - A license holds exactly one STR Certificate, and that certificate's number
 *   is the `registration_id`.
 *
 * A failure here is not a flake: it means the Muni changed how it issues
 * these, and the vocabulary and the views need revisiting. Measured
 * 2026-09-15, when the layer held 2,564 registrations.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { fetchLicensePages, type LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import {
  cityviewLicenseIdFromStatusUrl,
  fetchRegistrations,
  type Registration,
} from '@anchorage-str-db/scraper-muni-str/registrationLayers';

/** Enough licenses to catch a second certificate, spread across issue months. */
const SAMPLED_REGISTRATIONS = [
  'STR20260309', // May
  'STR20260126',
  'STR20260866',
  'STR20261282', // June, one of four under PHOENIX ONE COMPANIES LLC
  'STR20262410', // July
  'STR20262553', // August
] as const;

let registrations: Registration[] = [];
const pages = new Map<number, LicensePage>();

beforeAll(async () => {
  ({ registrations } = await fetchRegistrations());

  const sampled = SAMPLED_REGISTRATIONS.map((registrationId) => {
    const found = registrations.find((r) => r.registrationId === registrationId);
    if (!found) throw new Error(`${registrationId} is not in the layer`);
    const cityviewLicenseId = cityviewLicenseIdFromStatusUrl(found.statusUrl);
    if (cityviewLicenseId === null) throw new Error(`${registrationId} has no licenseId`);
    return cityviewLicenseId;
  });
  for (const result of await fetchLicensePages(sampled)) {
    if (!result.page) throw new Error(`license ${result.cityviewLicenseId}: ${result.error}`);
    if (result.page.hidden) throw new Error(`license ${result.cityviewLicenseId} is hidden`);
    pages.set(result.cityviewLicenseId, result.page);
  }
});

const distinct = <T>(values: readonly T[]) => new Set(values).size;

describe('registration, license and CityView ids', () => {
  it('are one-to-one-to-one across the layer', () => {
    // An empty or truncated fetch would satisfy every equality below.
    expect(registrations.length).toBeGreaterThan(2000);

    const registrationIds = registrations.map((r) => r.registrationId);
    const licenseIds = registrations.map((r) => r.licenseId);
    const cityviewIds = registrations.map((r) => cityviewLicenseIdFromStatusUrl(r.statusUrl));

    // None missing: every registration carries all three.
    expect(licenseIds.filter((id) => id === null)).toEqual([]);
    expect(cityviewIds.filter((id) => id === null)).toEqual([]);

    // None shared: each is unique, so each is a key on its own and joining on
    // any of them gives the same rows.
    expect(distinct(registrationIds)).toBe(registrations.length);
    expect(distinct(licenseIds)).toBe(registrations.length);
    expect(distinct(cityviewIds)).toBe(registrations.length);
  });

  it('give the licensee no identifier of their own', () => {
    const byBusiness = new Map<string, Registration[]>();
    for (const r of registrations) {
      if (!r.businessName || r.businessName === 'None') continue;
      const key = r.businessName.trim().toUpperCase();
      byBusiness.set(key, [...(byBusiness.get(key) ?? []), r]);
    }
    const repeated = [...byBusiness.values()].filter((rs) => rs.length > 1);
    expect(repeated.length).toBeGreaterThan(100);

    // If `license_id` identified the licensee, a business on several
    // registrations would repeat one. Every one of them has a separate id per
    // registration, so it identifies the license.
    const sharing = repeated.filter((rs) => distinct(rs.map((r) => r.licenseId)) < rs.length);
    expect(sharing.map((rs) => rs[0]!.businessName)).toEqual([]);
  });
});

describe('a license page', () => {
  it.each(SAMPLED_REGISTRATIONS)('holds %s as its only STR Certificate', (registrationId) => {
    const layer = registrations.find((r) => r.registrationId === registrationId)!;
    const page = pages.get(cityviewLicenseIdFromStatusUrl(layer.statusUrl)!)!;

    expect(page.licenseType).toBe('Short-Term Rentals');
    // One certificate, so the license and the registration are the same thing.
    const certificates = page.issuances.filter((i) => i.type === 'STR Certificate');
    expect(certificates).toHaveLength(1);
    expect(certificates[0]!.number).toBe(registrationId);
    // And the page agrees with the layer on the license's own id.
    expect(page.licenseId).toBe(layer.licenseId);
  });
});
