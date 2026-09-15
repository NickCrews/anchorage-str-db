/**
 * Writes for the registry run. The tables are defined in
 * `@anchorage-str-db/db/schema` and the views that read them in
 * `@anchorage-str-db/db/views`.
 */

import type { Database } from '@anchorage-str-db/db/database';
import { muniLicensePageReads, muniStrRegistrationObservations, muniStrRegistryRuns } from '@anchorage-str-db/db/schema';
import { CITYVIEW_LICENSE_ID_SQL } from '@anchorage-str-db/db/views';
import type { LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import {
  cityviewLicenseIdFromStatusUrl,
  type Registration,
} from '@anchorage-str-db/scraper-muni-str/registrationLayers';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';

// --------------------------------------------------------------------------
// registrations

export interface RegistrationStats {
  seen: number;
  new: number;
  lapsed: number;
}

/**
 * Write one registry run's registrations. Idempotent per scrape date: re-running a
 * day replaces its rows. Throws on a repeated registration id, which the
 * layer should never publish.
 */
export async function recordRegistrations(
  db: Database,
  scrapeDate: IsoDate,
  registrations: readonly Registration[],
): Promise<RegistrationStats> {
  const numbers = new Set(registrations.map((r) => r.registrationId));
  if (numbers.size !== registrations.length) {
    throw new Error(
      `the registration layer repeats ${registrations.length - numbers.size} registration ids`,
    );
  }

  await db.run('DELETE FROM muni_str_registration_observations WHERE scrape_date = CAST(? AS DATE)', [
    scrapeDate,
  ]);

  const previous = await db.rows<{ registration_id: string; last_seen: string }>(
    'SELECT registration_id, max(scrape_date) AS last_seen FROM muni_str_registration_observations ' +
      'GROUP BY registration_id',
  );
  const previousRunDate = previous.reduce<string | null>(
    (latest, row) => (latest === null || row.last_seen > latest ? row.last_seen : latest),
    null,
  );
  const everSeen = new Set(previous.map((row) => row.registration_id));

  await db.appendRows(
    muniStrRegistrationObservations,
    registrations.map((r) => ({
      registrationId: r.registrationId,
      scrapeDate,
      licenseId: r.licenseId,
      submittedDate: r.submittedDate,
      issuedDate: r.issuedDate,
      expiresDate: r.expiresDate,
      registeredAddress: r.registeredAddress,
      businessName: r.businessName,
      status: r.status,
      statusUrl: r.statusUrl,
      communityCouncil: r.communityCouncil,
      parcelType: r.parcelType,
      geocodedAddress: r.geocodedAddress,
      geocodedLat: r.geocodedLat,
      geocodedLng: r.geocodedLng,
      publishedAt: r.publishedAt,
    })),
  );

  return {
    seen: registrations.length,
    new: registrations.filter((r) => !everSeen.has(r.registrationId)).length,
    lapsed: previous.filter(
      (row) => row.last_seen === previousRunDate && !numbers.has(row.registration_id),
    ).length,
  };
}

// --------------------------------------------------------------------------
// license pages

/**
 * Store each page read. Idempotent per (license, scrape date): a page read
 * twice in one day keeps the later read, and other pages read earlier that
 * day are kept.
 */
export async function recordLicensePages(
  db: Database,
  scrapeDate: IsoDate,
  pages: readonly LicensePage[],
): Promise<void> {
  if (pages.length === 0) return;
  await db.run(
    'CREATE OR REPLACE TEMP TABLE stg_license_pages AS ' +
      'SELECT * FROM muni_license_page_reads LIMIT 0',
  );
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
    })),
    { into: 'stg_license_pages' },
  );
  await db.run(
    'DELETE FROM muni_license_page_reads WHERE (cityview_license_id, scrape_date) IN ' +
      '(SELECT cityview_license_id, scrape_date FROM stg_license_pages)',
  );
  await db.run('INSERT INTO muni_license_page_reads SELECT * FROM stg_license_pages');
  await db.run('DROP TABLE stg_license_pages');
}

export interface LicensePageSelection {
  /** License ids in today's layer. */
  today: ReadonlySet<number>;
  /** Each license's latest read date. */
  lastRead: ReadonlyMap<number, IsoDate>;
  /** Each license's last date in the layer before today. */
  lastSeen: ReadonlyMap<number, IsoDate>;
  scrapeDate: IsoDate;
  refreshDays: number;
  max: number;
}

/**
 * Which license pages to read this run, at most `max`, in priority order:
 *
 * 1. In today's layer and never read.
 * 2. Gone from today's layer and not read since it was last in it, so the
 *    page's status records why it left. Read once.
 * 3. In today's layer, with a latest read `refreshDays` or more old, oldest
 *    first.
 *
 * Ties go to the lower license id. A failed read writes nothing, so the
 * license keeps its place for the next run.
 */
export function chooseLicensePages(selection: LicensePageSelection): number[] {
  const { today, lastRead, lastSeen, scrapeDate } = selection;
  const byId = (a: number, b: number) => a - b;

  const unread = [...today].filter((id) => !lastRead.has(id)).sort(byId);
  const lapsed = [...lastSeen]
    .filter(([id, seen]) => !today.has(id) && (lastRead.get(id) ?? '') <= seen)
    .map(([id]) => id)
    .sort(byId);
  const staleBefore = addDays(scrapeDate, -selection.refreshDays);
  const stale = [...today]
    .filter((id) => {
      const read = lastRead.get(id);
      return read !== undefined && read <= staleBefore;
    })
    .sort((a, b) => lastRead.get(a)!.localeCompare(lastRead.get(b)!) || a - b);

  return [...unread, ...lapsed, ...stale].slice(0, selection.max);
}

/** `chooseLicensePages` over the database's history and today's layer. */
export async function pendingLicensePages(
  db: Database,
  scrapeDate: IsoDate,
  registrations: readonly Registration[],
  options: { refreshDays: number; max: number },
): Promise<number[]> {
  const today = new Set(
    registrations.flatMap((r) => {
      const id = cityviewLicenseIdFromStatusUrl(r.statusUrl);
      return id === null ? [] : [id];
    }),
  );
  const reads = await db.rows<{ cityview_license_id: number; last_read: string }>(
    'SELECT cityview_license_id, max(scrape_date) AS last_read FROM muni_license_page_reads GROUP BY cityview_license_id',
  );
  const seen = await db.rows<{ cityview_license_id: number; last_seen: string }>(
    `SELECT ${CITYVIEW_LICENSE_ID_SQL} AS cityview_license_id, max(scrape_date) AS last_seen ` +
      'FROM muni_str_registration_observations WHERE scrape_date < CAST(? AS DATE) ' +
      'GROUP BY ALL HAVING cityview_license_id IS NOT NULL',
    [scrapeDate],
  );
  return chooseLicensePages({
    today,
    lastRead: new Map(reads.map((row) => [row.cityview_license_id, row.last_read])),
    lastSeen: new Map(seen.map((row) => [row.cityview_license_id, row.last_seen])),
    scrapeDate,
    ...options,
  });
}

// --------------------------------------------------------------------------
// run log

/** Every column, so a caller cannot leave a count out by omission. */
export type RegistryRunRow = Required<typeof muniStrRegistryRuns.$inferInsert>;

export async function logRegistryRun(db: Database, run: RegistryRunRow): Promise<void> {
  await db.orm.insert(muniStrRegistryRuns).values(run);
}
