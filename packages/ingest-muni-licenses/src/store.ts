/**
 * Reads and writes for the license scan. The tables are defined in
 * `@anchorage-str-db/db/schema/muniLicenses` and
 * `@anchorage-str-db/db/schema/muniGis`.
 */

import type { Database } from '@anchorage-str-db/db/database';
import { muniAddressGeocodes, muniParcelTypes } from '@anchorage-str-db/db/schema/muniGis';
import {
  muniLicenseHiddenReads,
  muniLicensePageReads,
  muniLicenseRuns,
} from '@anchorage-str-db/db/schema/muniLicenses';
import type { HiddenLicensePage, LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import { SHORT_TERM_RENTALS, type LatestRead } from './select.ts';

/** Each id's latest read, visible or hidden. */
export async function latestReads(db: Database): Promise<LatestRead[]> {
  const rows = await db.rows<{
    cityview_license_id: number;
    scrape_date: string;
    hidden: boolean;
    license_type: string | null;
  }>(
    'SELECT cityview_license_id, scrape_date, hidden, license_type FROM (' +
      'SELECT cityview_license_id, scrape_date, false AS hidden, license_type FROM muni_license_page_reads ' +
      'UNION ALL ' +
      'SELECT cityview_license_id, scrape_date, true AS hidden, NULL AS license_type FROM muni_license_hidden_reads' +
      ') QUALIFY row_number() OVER (PARTITION BY cityview_license_id ORDER BY scrape_date DESC, hidden) = 1',
  );
  return rows.map((row) => ({
    cityviewLicenseId: row.cityview_license_id,
    scrapeDate: row.scrape_date,
    hidden: row.hidden,
    licenseType: row.license_type,
  }));
}

export interface ReadStats {
  /** Visible pages of licenses with no visible read before the scrape date. */
  licensesNew: number;
  /** Visible pages whose page or issuance statuses differ from the license's previous visible read. */
  licensesStatusChanged: number;
}

/**
 * Store one scan's reads. Idempotent per (id, scrape date): a read replaces
 * any read of the same id earlier that day, visible or hidden, and other
 * ids read earlier that day are kept.
 */
export async function recordLicenseReads(
  db: Database,
  scrapeDate: IsoDate,
  pages: readonly LicensePage[],
  hidden: readonly HiddenLicensePage[],
): Promise<ReadStats> {
  await db.run(
    'CREATE OR REPLACE TEMP TABLE stg_license_pages AS SELECT * FROM muni_license_page_reads LIMIT 0',
  );
  await db.run(
    'CREATE OR REPLACE TEMP TABLE stg_license_hidden AS SELECT * FROM muni_license_hidden_reads LIMIT 0',
  );
  if (pages.length) {
    await db.appendRows(
      muniLicensePageReads,
      pages.map((page) => ({
        cityviewLicenseId: page.cityviewLicenseId,
        scrapeDate,
        licenseId: page.licenseId,
        businessName: page.businessName,
        licenseType: page.licenseType,
        status: page.status,
        description: page.description,
        locations: page.locations.map((l) => ({ label: l.label, value: l.value, link: l.link })),
        issuances: page.issuances.map((i) => ({
          type: i.type,
          issued_date: i.issuedDate,
          expires_date: i.expiresDate,
          status: i.status,
          number: i.number,
        })),
        submittals: page.submittals.map((s) => ({
          name: s.name,
          type: s.type,
          date: s.date,
          status: s.status,
        })),
      })),
      { into: 'stg_license_pages' },
    );
  }
  if (hidden.length) {
    await db.appendRows(
      muniLicenseHiddenReads,
      hidden.map((page) => ({ cityviewLicenseId: page.cityviewLicenseId, scrapeDate })),
      { into: 'stg_license_hidden' },
    );
  }

  // Against reads before today, so a re-run of the day counts the same.
  const [stats] = await db.rows<{ licenses_new: number; licenses_status_changed: number }>(
    'WITH previous AS (' +
      'SELECT cityview_license_id, status, [i.status FOR i IN issuances] AS issuance_statuses ' +
      'FROM muni_license_page_reads WHERE scrape_date < CAST(? AS DATE) ' +
      'QUALIFY row_number() OVER (PARTITION BY cityview_license_id ORDER BY scrape_date DESC) = 1' +
      ') SELECT ' +
      'count(*) FILTER (WHERE p.cityview_license_id IS NULL)::INTEGER AS licenses_new, ' +
      'count(*) FILTER (WHERE p.cityview_license_id IS NOT NULL AND (' +
      's.status IS DISTINCT FROM p.status OR ' +
      '[i.status FOR i IN s.issuances] IS DISTINCT FROM p.issuance_statuses))::INTEGER AS licenses_status_changed ' +
      'FROM stg_license_pages s LEFT JOIN previous p USING (cityview_license_id)',
    [scrapeDate],
  );

  const replaced =
    '(SELECT cityview_license_id, scrape_date FROM stg_license_pages ' +
    'UNION ALL SELECT cityview_license_id, scrape_date FROM stg_license_hidden)';
  await db.run(`DELETE FROM muni_license_page_reads WHERE (cityview_license_id, scrape_date) IN ${replaced}`);
  await db.run(`DELETE FROM muni_license_hidden_reads WHERE (cityview_license_id, scrape_date) IN ${replaced}`);
  await db.run('INSERT INTO muni_license_page_reads SELECT * FROM stg_license_pages');
  await db.run('INSERT INTO muni_license_hidden_reads SELECT * FROM stg_license_hidden');
  await db.run('DROP TABLE stg_license_pages');
  await db.run('DROP TABLE stg_license_hidden');

  return {
    licensesNew: stats?.licenses_new ?? 0,
    licensesStatusChanged: stats?.licenses_status_changed ?? 0,
  };
}

/** Every column, so a caller cannot leave a count out by omission. */
export type LicenseRunRow = Required<typeof muniLicenseRuns.$inferInsert>;

export async function logLicenseRun(db: Database, run: LicenseRunRow): Promise<void> {
  await db.orm.insert(muniLicenseRuns).values(run);
}

/**
 * Addresses of licenses in `licenses` to send to the geocoder, at most `max`:
 * those never sent, then those last sent on or before `retryMissesBy`
 * without a match. A match is never asked about again. Within each, a
 * Short-Term Rentals license's address comes first, then the newest license.
 */
export async function addressesToGeocode(db: Database, retryMissesBy: IsoDate, max: number): Promise<string[]> {
  const rows = await db.rows<{ address: string }>(
    'SELECT l.address FROM licenses l LEFT JOIN muni_address_geocodes g USING (address) ' +
      'WHERE l.address IS NOT NULL AND (g.address IS NULL OR ' +
      '(g.matched_address IS NULL AND g.geocoded_date <= CAST(? AS DATE))) ' +
      'GROUP BY l.address ' +
      'ORDER BY bool_or(g.address IS NULL) DESC, bool_or(l.license_type = ?) DESC, ' +
      'max(l.cityview_license_id) DESC, l.address LIMIT ?',
    [retryMissesBy, SHORT_TERM_RENTALS, max],
  );
  return rows.map((row) => row.address);
}

/**
 * Parcel ids on licenses in `licenses` (every location labelled `Property`)
 * to read the `Property_Type` of, at most `max`: those never read, then those
 * last read on or before `refreshBy`, oldest first.
 */
export async function parcelIdsToRead(db: Database, refreshBy: IsoDate, max: number): Promise<string[]> {
  const rows = await db.rows<{ parcel_id: string }>(
    'SELECT p.parcel_id FROM (' +
      "SELECT DISTINCT unnest([l.value FOR l IN locations IF l.label = 'Property']) AS parcel_id FROM licenses" +
      ') p LEFT JOIN muni_parcel_types t USING (parcel_id) ' +
      'WHERE p.parcel_id IS NOT NULL AND (t.parcel_id IS NULL OR t.read_date <= CAST(? AS DATE)) ' +
      'ORDER BY t.read_date NULLS FIRST, p.parcel_id LIMIT ?',
    [refreshBy, max],
  );
  return rows.map((row) => row.parcel_id);
}

export type AddressGeocodeRow = typeof muniAddressGeocodes.$inferInsert;
export type ParcelTypeRow = typeof muniParcelTypes.$inferInsert;

/**
 * Store geocodes and parcel types. A row replaces any earlier row for the
 * same address or parcel id.
 */
export async function recordGisReads(
  db: Database,
  geocodes: readonly AddressGeocodeRow[],
  parcelTypes: readonly ParcelTypeRow[],
): Promise<void> {
  const replace = async <T extends typeof muniAddressGeocodes | typeof muniParcelTypes>(
    table: T,
    name: string,
    key: string,
    rows: readonly T['$inferInsert'][],
  ): Promise<void> => {
    if (!rows.length) return;
    const staging = `stg_${name}`;
    await db.run(`CREATE OR REPLACE TEMP TABLE ${staging} AS SELECT * FROM ${name} LIMIT 0`);
    await db.appendRows(table, rows, { into: staging });
    await db.run(`DELETE FROM ${name} WHERE ${key} IN (SELECT ${key} FROM ${staging})`);
    await db.run(`INSERT INTO ${name} SELECT * FROM ${staging}`);
    await db.run(`DROP TABLE ${staging}`);
  };
  await replace(muniAddressGeocodes, 'muni_address_geocodes', 'address', geocodes);
  await replace(muniParcelTypes, 'muni_parcel_types', 'parcel_id', parcelTypes);
}
