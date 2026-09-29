/**
 * What one registration covers, checked against the live registration layer
 * rather than assumed.
 *
 * It is tempting to read a registration as one row per (registrant, address),
 * or per (registrant, address, unit designator), and to group listings or count
 * dwellings on that basis. The layer does not work that way: the registrant
 * decides what to file, so the same registrant files several registrations at
 * one address, and one registration can cover a whole building. No tuple keys a registration
 * but its own `registration_id`.
 *
 * A failure here is not a flake: it means the Muni changed what a registration
 * covers, and CONTEXT.md and anything grouping on (registrant, address) need
 * revisiting. Measured 2026-09-15, when the layer held 2,564 registrations and
 * 115 (registrant, address) pairs held 293 of them.
 *
 * The other direction — one registration covering many rooms or dwellings — is an Airbnb
 * fact rather than a layer one (STR20261701 is cited by 8 private-room
 * listings), so it is evidenced in docs/research/rental-units/README.md.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  fetchRegistrations,
  type Registration,
} from '@anchorage-str-db/scraper-muni-str/registrationLayers';

let registrations: Registration[] = [];

beforeAll(async () => {
  ({ registrations } = await fetchRegistrations());
});

const text = (value: string | null) => (value ?? '').trim().toUpperCase();

/** The registrant and address as filed, compared the way a reader would. */
const registrantAndAddress = (r: Registration) =>
  `${text(r.businessName)}|${text(r.registeredAddress)}`;

function groupBy(rs: readonly Registration[], of: (r: Registration) => string): Registration[][] {
  const groups = new Map<string, Registration[]>();
  for (const r of rs) groups.set(of(r), [...(groups.get(of(r)) ?? []), r]);
  return [...groups.values()];
}

describe('what a registration covers', () => {
  it('is not keyed by (registrant, address)', () => {
    // An empty or truncated fetch would satisfy the inequalities below.
    expect(registrations.length).toBeGreaterThan(2000);

    const named = registrations.filter((r) => r.businessName && r.businessName !== 'None');
    const repeated = groupBy(named, registrantAndAddress).filter((rs) => rs.length > 1);

    // Were (registrant, address) the grain, every group would hold one
    // registration. Many hold several, so grouping on it merges registrations
    // that the Muni issued separately.
    expect(repeated.length).toBeGreaterThan(50);
    expect(repeated.reduce((n, rs) => n + rs.length, 0)).toBeGreaterThan(150);

    // Not a near-miss either: the repeats share the address string exactly, so
    // this is not an artifact of unnormalized typing.
    expect(Math.max(...repeated.map((rs) => rs.length))).toBeGreaterThanOrEqual(3);
  });

  it('is not keyed by address alone', () => {
    const addressed = registrations.filter((r) => r.registeredAddress);
    const shared = groupBy(addressed, (r) => text(r.registeredAddress)).filter((rs) => rs.length > 1);
    expect(shared.length).toBeGreaterThan(50);
  });

  it('can be finer than one dwelling: 400 Turpin St Unit 8 is registered per bedroom', () => {
    // One registrant, one apartment, one registration per bedroom. A dwelling
    // count that trusts the registration grain reads this as four dwellings.
    const turpin = registrations.filter((r) => /400 Turpin St/i.test(r.registeredAddress ?? ''));
    expect(turpin.length).toBeGreaterThan(1);
    expect(new Set(turpin.map((r) => text(r.businessName))).size).toBe(1);
    expect(new Set(turpin.map((r) => r.registrationId)).size).toBe(turpin.length);
  });
});
