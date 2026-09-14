/**
 * Reads real license pages from the Muni's CityView portal, one per markup
 * case the parser must handle. The portal's markup is the risk, so these
 * tests use no saved or synthetic HTML: when the Muni changes a page, they
 * fail.
 *
 * Expected values are the pages' contents on 2026-09-14. A failure on a single
 * field can also mean the licensee changed their license; open the page to
 * tell which.
 */

import { describe, expect, it } from 'vitest';

import { rootCause } from '@anchorage-str-db/utils/log';

import {
  fetchLicensePages,
  licensePageUrl,
  liveLicensePageFetcher,
  type LicensePage,
} from '../src/licensePage.ts';

const fetchOne = liveLicensePageFetcher();

/** The portal's property search URL, as linked from a license page. */
function search(encodedValue: string): string {
  return `https://www.muni.org/CityViewPortal/Property/PropertyReview?searchKey=desc&searchValue=${encodedValue}`;
}

function read(licenseId: number): Promise<LicensePage> {
  return fetchOne(licenseId);
}

describe('license pages on the live portal', () => {
  it('reads every summary field, a parcel and an address, and an issuance', async () => {
    expect(await read(13923)).toEqual({
      licenseId: 13923,
      licenseeNumber: 'LC260500349',
      businessName: 'Echo Ridge Mountain Retreat',
      licenseType: 'Short-Term Rentals',
      status: 'Active',
      description: 'Provides short term rentals, logistics, meeting space and overnight lodging.',
      locations: [
        { label: 'Property', value: '07606227000', link: search('07606227000') },
        {
          label: 'Address',
          value: '257 ECHO RIDGE DR, GIRDWOOD, AK 99587',
          link: search('257%20ECHO%20RIDGE%20DR%2C%20GIRDWOOD%2C%20AK%2099587'),
        },
      ],
      issuances: [
        {
          type: 'STR Certificate',
          issuedDate: '2026-05-04',
          expiresDate: '2027-04-30',
          status: 'Active',
          number: 'STR20260309',
        },
      ],
    });
  });

  it('reads a location given as free text, with no label and no link', async () => {
    const page = await read(15993);

    expect(page.locations).toEqual([
      {
        label: null,
        value: '4425 E 6TH AVE ANCHORAGE ALASKA, 99508, ROOM 4, ANCHORAGE AK 99508',
        link: null,
      },
    ]);
    expect(page.description).toBe(
      'Providing private rooms, suites, and standalone homes across Anchorage — nightly, weekly, or monthly.',
    );
  });

  it('reads a free-text location containing #', async () => {
    expect((await read(13664)).locations).toEqual([
      { label: null, value: '525 w 3rd Ave #501, anchorage AK 99501', link: null },
    ]);
  });

  it('reads a free-text parcel id after a labeled address', async () => {
    expect((await read(13990)).locations).toEqual([
      {
        label: 'Address',
        value: '9256 CAMPBELL TERRACE DR, ANCHORAGE, AK 99502',
        link: search('9256%20CAMPBELL%20TERRACE%20DR%2C%20ANCHORAGE%2C%20AK%2099502'),
      },
      { label: null, value: '01237318000', link: null },
    ]);
  });

  it('reads an address with no parcel', async () => {
    expect((await read(13613)).locations).toEqual([
      {
        label: 'Address',
        value: '8140 KRONOS DR, Unit:DUPL A, ANCHORAGE, AK 99502',
        link: search('8140%20KRONOS%20DR%2C%20Unit%3ADUPL%20A%2C%20ANCHORAGE%2C%20AK%2099502'),
      },
    ]);
  });

  it('reads two parcels and an address, in page order', async () => {
    const page = await read(13640);

    expect(page.locations).toEqual([
      { label: 'Property', value: '00109519000', link: search('00109519000') },
      { label: 'Property', value: '01007223000', link: search('01007223000') },
      {
        label: 'Address',
        value: '3521 BRUCE LN, ANCHORAGE, AK 99517',
        link: search('3521%20BRUCE%20LN%2C%20ANCHORAGE%2C%20AK%2099517'),
      },
    ]);
    expect(page.businessName).toBe("Walt's Place");
  });

  it('keeps the error message the portal shows in place of a label', async () => {
    // The apostrophe in WENDY'S WAY breaks the portal's own parcel lookup.
    expect((await read(13966)).locations).toEqual([
      {
        label: "Error: Syntax error: Missing operand after 'SWAY' operator.",
        value: "2955 WENDY'S WAY, ANCHORAGE, AK 99517",
        link: search('2955%20WENDY%27S%20WAY%2C%20ANCHORAGE%2C%20AK%2099517'),
      },
    ]);
  });

  it('keeps line breaks and repeated spaces inside a description', async () => {
    const description = (await read(13939)).description;

    expect(description).toBe(
      'This business operates a short-term rental property, offering fully furnished accommodations ' +
        'to travelers and temporary guests. The property is rented on a nightly or weekly basis and is ' +
        'intended for vacationers, business travelers, and visitors seeking short-term lodging.\n\n' +
        'The rental includes essential amenities such as a furnished living space, kitchen facilities, ' +
        'bathroom, and sleeping areas. Guests may book the property through online rental platforms or ' +
        'direct communication.\n\n' +
        'The business is owner-operated and focuses on providing a clean, safe, and comfortable ' +
        'environment for guests. House rules, occupancy limits, and local regulations are followed to ' +
        'ensure responsible use of the property and minimal impact on the surrounding community.',
    );
    expect((await read(13613)).description).toBe(
      'I have two AirBnB rooms that I rent inside my home.  I live upstairs and the rooms are ' +
        'downstairs.  My AK business license number is 2234947.  Exp. Dec. 31, 2027.',
    );
  });

  it('decodes an ampersand and keeps a curly apostrophe', async () => {
    expect((await read(13623)).businessName).toBe('Aim & Ehtylb LLC');
    expect((await read(13625)).businessName).toBe('Wendy’s Girdwood Getaway');
  });

  it('rejects the Invalid License page for an unknown id', async () => {
    const err = await read(50).catch((e: unknown) => e);

    expect(String(rootCause(err))).toMatch(/license 50: .*Invalid License/);
  });
});

describe('fetchLicensePages', () => {
  it('returns each page, and the error for a page that could not be read', async () => {
    const results = await fetchLicensePages([13923, 50]);

    expect(results.map((result) => [result.licenseId, result.page?.licenseeNumber ?? null])).toEqual([
      [13923, 'LC260500349'],
      [50, null],
    ]);
    expect(results[1]!.error).toMatch(/Invalid License/);
  });
});

describe('licensePageUrl', () => {
  it('builds the status URL the registration layer links to', () => {
    expect(licensePageUrl(13923)).toBe(
      'https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B',
    );
  });
});
