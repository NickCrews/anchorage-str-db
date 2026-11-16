/**
 * Which license ids a scrape reads. The read history in the database is the
 * scrape's only state: every id read, when, and whether it was hidden.
 */

import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

/** License pages read per scrape. At ~0.5 s a page, 3000 reads take about 25 minutes. */
export const MAX_READS_PER_SCRAPE = 3000;

/** A hidden license id among this many newest ids is re-read daily: a new license is often hidden at first. */
export const RECENT_ID_WINDOW = 500;

/** Days before an id's latest read is due again, by what it was. */
export const REFRESH_DAYS = {
  recentHidden: 1,
  shortTermRentals: 7,
  otherLicense: 30,
  olderHidden: 90,
} as const;

export const SHORT_TERM_RENTALS = 'Short-Term Rentals';

/** An id's latest read. */
export interface LatestRead {
  cityviewLicenseId: number;
  scrapeDate: IsoDate;
  hidden: boolean;
  /** The page's license type; null for a hidden id. */
  licenseType: string | null;
}

export interface LicenseIdSelection {
  /** The newest visible license's id, from the License Locator. */
  newestCityviewLicenseId: number;
  /** One per id ever read. */
  latestReads: readonly LatestRead[];
  scrapeDate: IsoDate;
  max: number;
}

/**
 * The ids to read this scrape, at most `max`, in this order:
 *
 * 1. Ids above the highest id ever read (visible or hidden), up to the
 *    newest, newest first.
 * 2. Ids never read, from the highest id ever read down to 1, newest first.
 * 3. Hidden ids among the `RECENT_ID_WINDOW` newest ids, last read 1 day ago
 *    or more.
 * 4. Short-Term Rentals licenses last read 7 days ago or more.
 * 5. Licenses of other types last read 30 days ago or more.
 * 6. Older hidden ids last read 90 days ago or more.
 *
 * Within 3 to 6, the oldest read comes first, then the newest id. A failed
 * read writes nothing, so its id keeps its place for the next scrape.
 */
export function chooseLicenseIds(selection: LicenseIdSelection): number[] {
  const { newestCityviewLicenseId: newest, latestReads, scrapeDate, max } = selection;
  const chosen: number[] = [];
  const full = () => chosen.length >= max;

  const highest = latestReads.reduce((top, read) => Math.max(top, read.cityviewLicenseId), 0);
  for (let id = newest; id > highest && !full(); id--) chosen.push(id);

  const read = new Set(latestReads.map((r) => r.cityviewLicenseId));
  for (let id = highest; id >= 1 && !full(); id--) {
    if (!read.has(id)) chosen.push(id);
  }

  const dueBy = (days: number) => addDays(scrapeDate, -days);
  const recentFloor = newest - RECENT_ID_WINDOW;
  const due = (days: number, include: (r: LatestRead) => boolean) =>
    latestReads
      .filter((r) => include(r) && r.scrapeDate <= dueBy(days))
      .sort((a, b) => a.scrapeDate.localeCompare(b.scrapeDate) || b.cityviewLicenseId - a.cityviewLicenseId)
      .map((r) => r.cityviewLicenseId);

  const refreshes = [
    due(REFRESH_DAYS.recentHidden, (r) => r.hidden && r.cityviewLicenseId > recentFloor),
    due(REFRESH_DAYS.shortTermRentals, (r) => !r.hidden && r.licenseType === SHORT_TERM_RENTALS),
    due(REFRESH_DAYS.otherLicense, (r) => !r.hidden && r.licenseType !== SHORT_TERM_RENTALS),
    due(REFRESH_DAYS.olderHidden, (r) => r.hidden && r.cityviewLicenseId <= recentFloor),
  ];
  for (const ids of refreshes) {
    for (const id of ids) {
      if (full()) return chosen;
      chosen.push(id);
    }
  }
  return chosen.slice(0, max);
}
