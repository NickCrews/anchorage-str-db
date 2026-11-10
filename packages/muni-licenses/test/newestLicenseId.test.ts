/**
 * `parseNewestCityviewLicenseId` offline: which id it takes from a License
 * Locator response, and what it rejects. `licensePage.test.ts` reads the real
 * Locator; these cover the cases it cannot produce on demand.
 */

import { describe, expect, it } from 'vitest';

import { parseNewestCityviewLicenseId } from '../src/licensePage.ts';

/** A Locator response listing these ids, in order, the way the portal links each. */
function locatorResponse(ids: readonly number[]): string {
  const items = ids
    .map(
      (id) =>
        `<li><span class="basicText"><a href="/CityViewPortal/License/Status?licenseId=${id}&amp;category=B">License Status</a></span></li>`,
    )
    .join('\r\n');
  return JSON.stringify({ View: `<fieldset><ul>${items}</ul></fieldset>`, LocationMarkers: [] });
}

describe('parseNewestCityviewLicenseId', () => {
  it('takes the highest id, not the first', () => {
    // The portal listed license 559 first on 2026-11-10, then 16459 and down.
    expect(parseNewestCityviewLicenseId(locatorResponse([559, 16459, 16458, 16457]))).toBe(16459);
  });

  it('rejects a response that is not JSON, such as the session-expired page', () => {
    expect(() => parseNewestCityviewLicenseId('<html><title>Session Expired</title></html>')).toThrow(/not JSON/);
  });

  it('rejects a response that lists no licenses', () => {
    expect(() => parseNewestCityviewLicenseId(locatorResponse([]))).toThrow(/listed no licenses/);
    expect(() => parseNewestCityviewLicenseId('{}')).toThrow(/no "View"/);
  });
});
