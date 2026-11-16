/**
 * Reads real license pages from the Muni's CityView portal, one per markup
 * case the parser must handle. The portal's markup is the risk, so these
 * tests use no saved or synthetic HTML: when the Muni changes a page, they
 * fail.
 *
 * Expected values are the pages' contents on 2026-09-14 (Short-Term Rentals)
 * and 2026-11-10 (Business, Alcohol, hidden ids). A failure on a single field
 * can also mean the licensee changed their license; open the page to tell
 * which.
 */

import { describe, expect, it } from 'vitest';

import {
  fetchLicensePages,
  fetchNewestCityviewLicenseId,
  licensePageUrl,
  liveLicensePageFetcher,
  type LicensePage,
} from '../src/licensePage.ts';

const fetchOne = liveLicensePageFetcher();

/** The portal's property search URL, as linked from a license page. */
function search(encodedValue: string): string {
  return `https://www.muni.org/CityViewPortal/Property/PropertyReview?searchKey=desc&searchValue=${encodedValue}`;
}

/** A visible license's page; throws on a hidden license id. */
async function read(cityviewLicenseId: number): Promise<LicensePage> {
  const page = await fetchOne(cityviewLicenseId);
  if (page.hidden) throw new Error(`license ${cityviewLicenseId} is hidden`);
  return page;
}

describe('license pages on the live portal', () => {
  it('reads every summary field, a parcel and an address, and an issuance', async () => {
    expect(await read(13923)).toEqual({
      hidden: false,
      cityviewLicenseId: 13923,
      licenseId: 'LC260500349',
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
      submittals: [],
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

  it('reads a Business license with no Locations section and a submittal', async () => {
    expect(await read(16427)).toEqual({
      hidden: false,
      cityviewLicenseId: 16427,
      licenseId: 'LC261002840',
      businessName: 'Frontier Intelligence Group',
      licenseType: 'Business',
      status: 'Active',
      description: '2026-2028 New PD',
      locations: [],
      issuances: [
        {
          type: 'Business License',
          issuedDate: '2026-10-15',
          expiresDate: '2028-10-01',
          status: 'Issued',
          number: 'PD 1476',
        },
      ],
      submittals: [
        { name: '1 Private Detective 10/13/2026', type: 'Private Detective', date: '2026-10-13', status: 'Pending' },
      ],
    });
  });

  it('reads an expired Business license whose page still says Active, with no submittals', async () => {
    const page = await read(13400);

    expect(page.locations).toEqual([]);
    expect(page.submittals).toEqual([]);
    expect(page.status).toBe('Active');
    expect(page.issuances).toEqual([
      {
        type: 'Business License',
        issuedDate: '2023-08-16',
        expiresDate: '2025-10-01',
        status: 'Expired',
        number: 'PD 1348',
      },
    ]);
  });

  it('reads Business licenses with no Locations section', async () => {
    for (const cityviewLicenseId of [9480, 13580]) {
      expect((await read(cityviewLicenseId)).locations).toEqual([]);
    }
  });

  it('reads a submittal with no type', async () => {
    expect((await read(13270)).submittals).toEqual([
      { name: '1 06/06/2023', type: null, date: '2023-06-06', status: 'Pending' },
    ]);
  });

  it('reads an Alcohol license: a starred address label, a free-text parcel id, an undated issuance', async () => {
    const page = await read(559);

    expect(page.licenseId).toBe('LC01867');
    expect(page.businessName).toBe("Chili's Bar and Grill");
    expect(page.licenseType).toBe('Alcohol');
    expect(page.locations).toEqual([
      {
        label: '* Address',
        value: '800 East Dimond Blvd. Suite 162',
        link: search('800%20East%20Dimond%20Blvd.%20Suite%20162'),
      },
      { label: null, value: '01309224000', link: null },
    ]);
    expect(page.issuances).toEqual([
      { type: 'Alcohol License', issuedDate: null, expiresDate: null, status: 'Active', number: null },
    ]);
    expect(page.submittals).toEqual([]);
  });

  it('returns a hidden license id\'s Invalid License page as hidden', async () => {
    expect(await fetchOne(50)).toEqual({ hidden: true, cityviewLicenseId: 50 });
    expect(await fetchOne(14417)).toEqual({ hidden: true, cityviewLicenseId: 14417 });
  });
});

describe('fetchLicensePages', () => {
  it('returns each page, a hidden page as hidden, and the error for a page that could not be read', async () => {
    const results = await fetchLicensePages([13923, 50, 0], {
      fetchOne: (id) => (id === 0 ? Promise.reject(new Error('no such page')) : fetchOne(id)),
    });

    expect(
      results.map((result) => [
        result.cityviewLicenseId,
        result.page === null ? null : result.page.hidden ? 'hidden' : result.page.licenseId,
        result.error,
      ]),
    ).toEqual([
      [13923, 'LC260500349', null],
      [50, 'hidden', null],
      [0, null, 'Error: no such page'],
    ]);
  });
});

describe('fetchNewestCityviewLicenseId', () => {
  it('finds the newest license id in the License Locator', async () => {
    const newest = await fetchNewestCityviewLicenseId();

    expect(Number.isInteger(newest)).toBe(true);
    // 16439 was a Short-Term Rentals license read on 2026-11-10; ids are never reused.
    expect(newest).toBeGreaterThanOrEqual(16439);
  });
});

describe('licensePageUrl', () => {
  it('builds the status URL the registration layer links to', () => {
    expect(licensePageUrl(13923)).toBe(
      'https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B',
    );
  });
});
