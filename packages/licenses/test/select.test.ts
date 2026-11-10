import { describe, expect, it } from 'vitest';

import { chooseLicenseIds, type LatestRead } from '../src/select.ts';

const SCRAPE_DATE = '2026-11-10';

const visible = (cityviewLicenseId: number, scrapeDate: string, licenseType = 'Short-Term Rentals'): LatestRead => ({
  cityviewLicenseId,
  scrapeDate,
  hidden: false,
  licenseType,
});
const hidden = (cityviewLicenseId: number, scrapeDate: string): LatestRead => ({
  cityviewLicenseId,
  scrapeDate,
  hidden: true,
  licenseType: null,
});

describe('chooseLicenseIds', () => {
  it('reads every id from the newest down on an empty history', () => {
    expect(chooseLicenseIds({ newestCityviewLicenseId: 5, latestReads: [], scrapeDate: SCRAPE_DATE, max: 100 })).toEqual(
      [5, 4, 3, 2, 1],
    );
  });

  it('stops at max, newest first, so the next scan continues below', () => {
    const first = chooseLicenseIds({ newestCityviewLicenseId: 16459, latestReads: [], scrapeDate: SCRAPE_DATE, max: 3 });
    expect(first).toEqual([16459, 16458, 16457]);

    const next = chooseLicenseIds({
      newestCityviewLicenseId: 16460,
      latestReads: first.map((id) => hidden(id, '2026-11-09')),
      scrapeDate: SCRAPE_DATE,
      max: 3,
    });
    // The new id above the highest read, then the never-read ones below it.
    expect(next).toEqual([16460, 16456, 16455]);
  });

  it('takes the six kinds of id in order', () => {
    const newest = 2000;
    const latestReads = [
      // Read ids, 1501..1999 skipping the ones below, all fresh.
      ...Array.from({ length: 499 }, (_, i) => 1501 + i)
        .filter((id) => ![1990, 1980, 1600].includes(id))
        .map((id) => visible(id, SCRAPE_DATE)),
      hidden(1990, '2026-11-09'), // 3: recent hidden, due after a day
      hidden(1980, '2026-11-08'), // 3: due, read earlier, so first
      hidden(1600, SCRAPE_DATE), // recent hidden read today: not due
      visible(1400, '2026-11-03'), // 4: STR, exactly 7 days
      visible(1401, '2026-11-04'), // STR, 6 days: not due
      visible(1300, '2026-10-01'), // 4: STR, older, so first
      visible(1200, '2026-10-11', 'Business'), // 5: 30 days
      visible(1201, '2026-10-12', 'Alcohol'), // other type, 29 days: not due
      hidden(1100, '2026-08-12'), // 6: older hidden, 90 days
      hidden(1101, '2026-08-13'), // older hidden, 89 days: not due
      hidden(1500, '2026-11-01'), // just outside the newest 500: not due
    ];
    const read = new Set(latestReads.map((r) => r.cityviewLicenseId));
    const neverRead = Array.from({ length: 1999 }, (_, i) => 1999 - i).filter((id) => !read.has(id));

    const chosen = chooseLicenseIds({ newestCityviewLicenseId: newest, latestReads, scrapeDate: SCRAPE_DATE, max: 5000 });

    expect(chosen).toEqual([2000, ...neverRead, 1980, 1990, 1300, 1400, 1200, 1100]);
  });

  it('breaks a tie in read date by the newest id', () => {
    const chosen = chooseLicenseIds({
      newestCityviewLicenseId: 3,
      latestReads: [visible(1, '2026-10-01'), visible(2, '2026-10-01'), visible(3, '2026-10-01')],
      scrapeDate: SCRAPE_DATE,
      max: 10,
    });
    expect(chosen).toEqual([3, 2, 1]);
  });

  it('caps the refreshes too', () => {
    const chosen = chooseLicenseIds({
      newestCityviewLicenseId: 3,
      latestReads: [visible(1, '2026-10-01'), visible(2, '2026-10-02'), visible(3, '2026-10-03')],
      scrapeDate: SCRAPE_DATE,
      max: 2,
    });
    expect(chosen).toEqual([1, 2]);
  });

  it('reads nothing above the newest id, nor anything read today', () => {
    const chosen = chooseLicenseIds({
      newestCityviewLicenseId: 2,
      latestReads: [visible(1, SCRAPE_DATE), hidden(2, SCRAPE_DATE), hidden(3, SCRAPE_DATE)],
      scrapeDate: SCRAPE_DATE,
      max: 10,
    });
    expect(chosen).toEqual([]);
  });
});
