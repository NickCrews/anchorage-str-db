/**
 * The Muni's CityView license pages, as the license scan reads them.
 *
 * - `muni_license_page_reads`: one row per visible CityView license page
 *   read, of any license type. Pages are read on a rolling schedule, not
 *   every run.
 * - `muni_license_hidden_reads`: one row per read of a hidden license id.
 * - `muni_license_runs`: one row per license scan.
 *
 * Together the two read tables are the scan's state: which ids have been
 * read, when, and what they were.
 */

import {
  integer,
  pgTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/pg-core';

import { day, naiveTimestamp, structList } from './columns.ts';

export interface LicenseLocation {
  label: string | null;
  value: string | null;
  link: string | null;
}

export interface LicenseIssuance {
  type: string | null;
  issued_date: string | null;
  expires_date: string | null;
  status: string | null;
  number: string | null;
}

export interface LicenseSubmittal {
  name: string | null;
  type: string | null;
  date: string | null;
  status: string | null;
}

/** A failed read writes no row. Text is as the page shows it. */
export const muniLicensePageReads = pgTable(
  'muni_license_page_reads',
  {
    cityviewLicenseId: integer('cityview_license_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),
    licenseId: varchar('license_id').notNull(),
    businessName: varchar('business_name'),
    // 'Short-Term Rentals'.
    licenseType: varchar('license_type'),
    status: varchar('status'),
    // The licensee's own description of the business.
    description: varchar('description'),
    // In page order. A value with a link is from the Muni's property records,
    // and the link is the portal's property search for it: label 'Property'
    // holds a parcel id, 'Address' the record's address. A value without a
    // link is text the registrant typed that matched no record, and usually
    // has no label. The label can be the portal's own lookup error
    // (license 13966).
    locations: structList<LicenseLocation>(
      'locations',
      'STRUCT(label VARCHAR, value VARCHAR, link VARCHAR)[]',
    ).notNull(),
    issuances: structList<LicenseIssuance>(
      'issuances',
      'STRUCT(type VARCHAR, issued_date DATE, expires_date DATE, status VARCHAR, number VARCHAR)[]',
    ).notNull(),
    // In page order; an empty list when the page says there are none. NULL on
    // the reads made by the registry run, which did not store them.
    submittals: structList<LicenseSubmittal>(
      'submittals',
      'STRUCT(name VARCHAR, type VARCHAR, date DATE, status VARCHAR)[]',
    ),
  },
  (t) => [primaryKey({ columns: [t.cityviewLicenseId, t.scrapeDate] })],
);

/**
 * A read of a hidden license id: the portal's "Invalid License" page, which
 * shows nothing about the license. A failed read writes no row.
 */
export const muniLicenseHiddenReads = pgTable(
  'muni_license_hidden_reads',
  {
    cityviewLicenseId: integer('cityview_license_id').notNull(),
    scrapeDate: day('scrape_date').notNull(),
  },
  (t) => [primaryKey({ columns: [t.cityviewLicenseId, t.scrapeDate] })],
);

/** Counts are NULL on a failed scan, which wrote nothing else. */
export const muniLicenseRuns = pgTable('muni_license_runs', {
  scrapeDate: day('scrape_date').notNull(),
  runStartedAt: naiveTimestamp('run_started_at').notNull(),
  runFinishedAt: naiveTimestamp('run_finished_at'),
  // The highest id on the License Locator's first page: the newest visible license.
  newestCityviewLicenseId: integer('newest_cityview_license_id'),
  // Ids whose page the scan tried to read; the next three add up to it.
  pagesAttempted: integer('pages_attempted'),
  // Visible pages read, stored in muni_license_page_reads.
  pagesRead: integer('pages_read'),
  // Hidden license ids read, stored in muni_license_hidden_reads.
  hiddenRead: integer('hidden_read'),
  pagesFailed: integer('pages_failed'),
  // Visible pages of licenses with no visible read before this scrape date.
  licensesNew: integer('licenses_new'),
  // Visible pages whose page or issuance statuses differ from the license's
  // previous visible read.
  licensesStatusChanged: integer('licenses_status_changed'),
  errorSummary: varchar('error_summary'),
});
