/**
 * DuckDB schema and writes for the Municipality's STR registry.
 *
 * The raw tables hold what the Muni publishes, as published:
 *
 * - `registration_observations`: append-only, one row per (registration,
 *   registry run) from the Clerk's ArcGIS layer. The layer lists only active
 *   registrations, so a registration's absence from a run is the only record
 *   that it lapsed.
 * - `license_page_reads`: one row per CityView license page read. Pages are
 *   read on a rolling schedule, not every run (see `pendingLicensePages`).
 * - `registry_runs`: one row per registry run.
 *
 * Views derive everything else: `registrations` has one row per registration
 * with its latest license page, and `listings_current_with_registration` joins
 * Airbnb listings to it on the registration number. Cleaning (the `'None'`
 * business name, the no-match placeholder point) happens in the views, so the
 * raw tables can always be re-derived.
 *
 * Registrations are stored as a daily snapshot rather than change-only:
 * ~2500 rows compress to ~50 KB a day, and a snapshot per run gives exact
 * first- and last-seen dates without interval logic.
 */

import {
  DATE,
  DOUBLE,
  INTEGER,
  LIST,
  STRUCT,
  TIMESTAMP,
  VARCHAR,
  dateValue,
  listValue,
  structValue,
  timestampValue,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';

import type { LicensePage } from '@anchorage-str-db/muni-licenses/licensePage';
import {
  NO_MATCH_GEOCODED_ADDRESS,
  licenseIdFromStatusUrl,
  type Registration,
} from '@anchorage-str-db/scraper-muni-str/registrationLayers';
import { addDays, epochDays, type IsoDate } from '@anchorage-str-db/utils/dates';

import { appendRow, type Database } from './db.ts';

export const REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS registration_observations (
    -- 'STR20260309'; Airbnb listings show it as str_registration_id.
    registration_number VARCHAR NOT NULL,
    scrape_date DATE NOT NULL,
    -- 'LC260500349', the license page's Licensee Number.
    application_number VARCHAR,
    submitted_date DATE,
    issued_date DATE,
    expires_date DATE,
    -- The address on the license. When the license is tied to a Muni property
    -- record, this is that record's address in the Muni's parcel-address style
    -- ('7730 MAYFAIR DR, Unit:APT 1, ANCHORAGE, AK 99502', or just
    -- '311 MELODY PL' when the record has no city); otherwise it is the text
    -- the applicant typed ('525 w 3rd Ave #501, anchorage AK 99501'). See
    -- license_page_reads.locations for which.
    location VARCHAR,
    -- The string 'None' when the registrant gave no business name.
    business_name VARCHAR,
    status VARCHAR,
    -- The CityView license page; its licenseId keys license_page_reads.
    status_url VARCHAR,
    -- The council containing the geocoded point; NULL exactly when geocoding
    -- found no match.
    community_council VARCHAR,
    -- 'Residential' or 'Commercial'. Can be NULL even when the license names
    -- a parcel and the address geocoded (7821 MAYFAIR DR, Unit:APT C).
    parcel_type VARCHAR,
    -- The Muni geocoder's (MOA_Multirole_Locator) reading of location, in its
    -- own style: '7821 Mayfair Dr, Apartment C, Anchorage, Alaska, 99502'.
    -- It rewrites typed text too ('#501' becomes 'Apartment 501', 'ROOM 4' is
    -- dropped). A location with no city or zip gets
    -- 'Incomplete address provided. No Match.' and a placeholder point.
    geocoded_address VARCHAR,
    -- The geocoded point, not a location the applicant gave.
    geocoded_lat DOUBLE,
    geocoded_lng DOUBLE,
    -- The layer's PUBDATE, naive UTC.
    published_at TIMESTAMP,

    PRIMARY KEY (registration_number, scrape_date)
);

-- A failed read writes no row. Text is as the page shows it.
CREATE TABLE IF NOT EXISTS license_page_reads (
    license_id INTEGER NOT NULL,
    scrape_date DATE NOT NULL,
    licensee_number VARCHAR NOT NULL,
    business_name VARCHAR,
    -- 'Short-Term Rentals'.
    license_type VARCHAR,
    status VARCHAR,
    -- The licensee's own description of the business.
    description VARCHAR,
    -- In page order. A value with a link is from the Muni's property records,
    -- and the link is the portal's property search for it: label 'Property'
    -- holds a parcel id, 'Address' the record's address. A value without a
    -- link is text the applicant typed that matched no record, and usually
    -- has no label. The label can be the portal's own lookup error
    -- (license 13966).
    locations STRUCT(label VARCHAR, value VARCHAR, link VARCHAR)[] NOT NULL,
    issuances STRUCT(
        type VARCHAR, issued_date DATE, expires_date DATE, status VARCHAR, number VARCHAR
    )[] NOT NULL,

    PRIMARY KEY (license_id, scrape_date)
);

-- Counts are NULL on a failed run, which wrote nothing else.
CREATE TABLE IF NOT EXISTS registry_runs (
    scrape_date DATE NOT NULL,
    run_started_at TIMESTAMP NOT NULL,
    run_finished_at TIMESTAMP,
    -- The registration layer's editingInfo.dataLastEditDate, naive UTC.
    layer_data_edited_at TIMESTAMP,
    registrations_seen INTEGER,
    registrations_new INTEGER,
    -- In the previous run's layer but not this one's.
    registrations_departed INTEGER,
    license_page_attempted INTEGER,
    license_page_failed INTEGER,
    error_summary VARCHAR
);
`;

const LICENSE_ID_SQL = "nullif(regexp_extract(status_url, '[?&]licenseId=(\\d+)', 1), '')::INTEGER";

/** Run after the listing views: `registrations` counts `listings_current`. */
export const REGISTRY_VIEWS_SQL = `
-- The latest registry run that completed its writes.
CREATE OR REPLACE VIEW latest_registry_date AS
SELECT max(scrape_date) AS scrape_date FROM registry_runs
WHERE registrations_seen IS NOT NULL;

CREATE OR REPLACE VIEW license_pages_latest AS
SELECT * FROM license_page_reads
QUALIFY row_number() OVER (PARTITION BY license_id ORDER BY scrape_date DESC) = 1;

-- One row per registration ever published, with its latest published fields
-- and latest license page. A registration is current if it was in the
-- latest registry run's layer, which lists only active registrations.
CREATE OR REPLACE VIEW registrations AS
WITH activity AS (
    SELECT
        registration_number,
        min(scrape_date) AS first_seen_date,
        max(scrape_date) AS last_seen_date
    FROM registration_observations
    GROUP BY registration_number
),
latest AS (
    SELECT *, ${LICENSE_ID_SQL} AS license_id
    FROM registration_observations
    QUALIFY row_number() OVER (PARTITION BY registration_number ORDER BY scrape_date DESC) = 1
),
airbnb AS (
    SELECT str_registration_id AS registration_number, count(*)::INTEGER AS listings
    FROM listings_current
    WHERE str_registration_id IS NOT NULL
    GROUP BY str_registration_id
)
SELECT
    o.registration_number,
    o.application_number,
    o.license_id,
    o.status,
    o.submitted_date,
    o.issued_date,
    o.expires_date,
    nullif(o.business_name, 'None') AS business_name,
    o.location,
    o.community_council,
    o.parcel_type,
    o.geocoded_address,
    -- NULL where the geocoder found no match, instead of its placeholder point.
    CASE WHEN o.geocoded_address IS DISTINCT FROM '${NO_MATCH_GEOCODED_ADDRESS}'
         THEN o.geocoded_lat END AS geocoded_lat,
    CASE WHEN o.geocoded_address IS DISTINCT FROM '${NO_MATCH_GEOCODED_ADDRESS}'
         THEN o.geocoded_lng END AS geocoded_lng,
    o.status_url,
    o.published_at,
    p.scrape_date AS license_read_date,
    p.status AS license_status,
    p.license_type,
    p.description AS license_description,
    p.business_name AS license_business_name,
    -- Parcel ids linked to property records. A parcel id typed as text has no
    -- label and is not included (license 13990).
    [l.value FOR l IN p.locations IF l.label = 'Property'] AS license_parcel_ids,
    [l.value FOR l IN p.locations IF l.label = 'Address'] AS license_addresses,
    -- The parcel id when the license lists exactly one; join to
    -- anchorage-property's parcels on it.
    CASE WHEN len([l FOR l IN p.locations IF l.label = 'Property']) = 1
         THEN [l.value FOR l IN p.locations IF l.label = 'Property'][1] END AS parcel_id,
    p.issuances AS license_issuances,
    coalesce(b.listings, 0) AS airbnb_listings_current,
    a.first_seen_date,
    a.last_seen_date,
    a.last_seen_date = (SELECT scrape_date FROM latest_registry_date) AS is_current
FROM latest o
JOIN activity a USING (registration_number)
LEFT JOIN license_pages_latest p ON p.license_id = o.license_id
LEFT JOIN airbnb b USING (registration_number);

CREATE OR REPLACE VIEW registrations_current AS
SELECT * FROM registrations WHERE is_current;

-- \`listings_current\` plus the registration its page cites. The registration
-- columns are NULL when the listing shows no number or the number is not in
-- the registry, which includes numbers issued since the layer's last publish.
CREATE OR REPLACE VIEW listings_current_with_registration AS
SELECT
    l.*,
    r.registration_number IS NOT NULL AS registration_found,
    r.is_current AS registration_is_current,
    r.business_name AS registration_business_name,
    r.location AS registration_location,
    r.parcel_id AS registration_parcel_id,
    r.parcel_type AS registration_parcel_type,
    r.community_council AS registration_community_council,
    r.issued_date AS registration_issued_date,
    r.expires_date AS registration_expires_date,
    r.license_description AS registration_license_description,
    r.airbnb_listings_current AS registration_airbnb_listings_current
FROM listings_current l
LEFT JOIN registrations r ON r.registration_number = l.str_registration_id;

COMMENT ON VIEW registrations IS 'One row per STR registration the Municipal Clerk has published, with its latest license page. is_current means it was in the latest registry run; the Muni publishes only active registrations.';
COMMENT ON VIEW listings_current_with_registration IS 'listings_current plus the Municipal registration matching str_registration_id. Registration columns are NULL when there is no match.';
`;

// --------------------------------------------------------------------------
// registrations

/** A naive UTC `YYYY-MM-DD HH:MM:SS` as a DuckDB `TIMESTAMP` value. */
function timestamp(value: string | null): DuckDBValue {
  if (value === null) return null;
  return timestampValue(BigInt(Date.parse(`${value.replace(' ', 'T')}Z`)) * 1000n);
}

function date(value: IsoDate | null): DuckDBValue {
  return value === null ? null : dateValue(epochDays(value));
}

const REGISTRATION_TYPES = [
  VARCHAR,
  DATE,
  VARCHAR,
  DATE,
  DATE,
  DATE,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  DOUBLE,
  DOUBLE,
  TIMESTAMP,
] satisfies DuckDBType[];

export interface RegistrationStats {
  seen: number;
  new: number;
  departed: number;
}

/**
 * Write one registry run's registrations. Idempotent per scrape date: re-running a
 * day replaces its rows. Throws on a repeated registration number, which the
 * layer should never publish.
 */
export async function recordRegistrations(
  db: Database,
  scrapeDate: IsoDate,
  registrations: readonly Registration[],
): Promise<RegistrationStats> {
  const numbers = new Set(registrations.map((r) => r.registrationNumber));
  if (numbers.size !== registrations.length) {
    throw new Error(
      `the registration layer repeats ${registrations.length - numbers.size} registration numbers`,
    );
  }

  await db.run('DELETE FROM registration_observations WHERE scrape_date = CAST(? AS DATE)', [
    scrapeDate,
  ]);

  const previous = await db.rows<{ registration_number: string; last_seen: string }>(
    'SELECT registration_number, max(scrape_date) AS last_seen FROM registration_observations ' +
      'GROUP BY registration_number',
  );
  const previousRunDate = previous.reduce<string | null>(
    (latest, row) => (latest === null || row.last_seen > latest ? row.last_seen : latest),
    null,
  );
  const everSeen = new Set(previous.map((row) => row.registration_number));

  const day = dateValue(epochDays(scrapeDate));
  if (registrations.length > 0) {
    const appender = await db.appender('registration_observations');
    for (const r of registrations) {
      appendRow(appender, REGISTRATION_TYPES, [
        r.registrationNumber,
        day,
        r.applicationNumber,
        date(r.submittedDate),
        date(r.issuedDate),
        date(r.expiresDate),
        r.location,
        r.businessName,
        r.status,
        r.statusUrl,
        r.communityCouncil,
        r.parcelType,
        r.geocodedAddress,
        r.geocodedLat,
        r.geocodedLng,
        timestamp(r.publishedAt),
      ]);
    }
    appender.flushSync();
    appender.closeSync();
  }

  return {
    seen: registrations.length,
    new: registrations.filter((r) => !everSeen.has(r.registrationNumber)).length,
    departed: previous.filter(
      (row) => row.last_seen === previousRunDate && !numbers.has(row.registration_number),
    ).length,
  };
}

// --------------------------------------------------------------------------
// license pages

const LOCATION_TYPE = STRUCT({ label: VARCHAR, value: VARCHAR, link: VARCHAR });
const ISSUANCE_TYPE = STRUCT({
  type: VARCHAR,
  issued_date: DATE,
  expires_date: DATE,
  status: VARCHAR,
  number: VARCHAR,
});

const LICENSE_PAGE_TYPES = [
  INTEGER,
  DATE,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  LIST(LOCATION_TYPE),
  LIST(ISSUANCE_TYPE),
] satisfies DuckDBType[];

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
      'SELECT * FROM license_page_reads LIMIT 0',
  );
  const staging = await db.appender('stg_license_pages');
  const day = dateValue(epochDays(scrapeDate));
  for (const page of pages) {
    appendRow(staging, LICENSE_PAGE_TYPES, [
      page.licenseId,
      day,
      page.licenseeNumber,
      page.businessName,
      page.licenseType,
      page.status,
      page.description,
      listValue(
        page.locations.map((l) => structValue({ label: l.label, value: l.value, link: l.link })),
      ),
      listValue(
        page.issuances.map((i) =>
          structValue({
            type: i.type,
            issued_date: date(i.issuedDate),
            expires_date: date(i.expiresDate),
            status: i.status,
            number: i.number,
          }),
        ),
      ),
    ]);
  }
  staging.flushSync();
  staging.closeSync();
  await db.run(
    'DELETE FROM license_page_reads WHERE (license_id, scrape_date) IN ' +
      '(SELECT license_id, scrape_date FROM stg_license_pages)',
  );
  await db.run('INSERT INTO license_page_reads SELECT * FROM stg_license_pages');
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
  const departed = [...lastSeen]
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

  return [...unread, ...departed, ...stale].slice(0, selection.max);
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
      const id = licenseIdFromStatusUrl(r.statusUrl);
      return id === null ? [] : [id];
    }),
  );
  const reads = await db.rows<{ license_id: number; last_read: string }>(
    'SELECT license_id, max(scrape_date) AS last_read FROM license_page_reads GROUP BY license_id',
  );
  const seen = await db.rows<{ license_id: number; last_seen: string }>(
    `SELECT ${LICENSE_ID_SQL} AS license_id, max(scrape_date) AS last_seen ` +
      'FROM registration_observations WHERE scrape_date < CAST(? AS DATE) ' +
      'GROUP BY ALL HAVING license_id IS NOT NULL',
    [scrapeDate],
  );
  return chooseLicensePages({
    today,
    lastRead: new Map(reads.map((row) => [row.license_id, row.last_read])),
    lastSeen: new Map(seen.map((row) => [row.license_id, row.last_seen])),
    scrapeDate,
    ...options,
  });
}

// --------------------------------------------------------------------------
// run log

export interface RegistryRunRow {
  scrapeDate: IsoDate;
  runStartedAt: string;
  runFinishedAt: string | null;
  layerDataEditedAt: string | null;
  registrationsSeen: number | null;
  registrationsNew: number | null;
  registrationsDeparted: number | null;
  licensePageAttempted: number | null;
  licensePageFailed: number | null;
  errorSummary: string | null;
}

export async function logRegistryRun(db: Database, run: RegistryRunRow): Promise<void> {
  await db.run(
    'INSERT INTO registry_runs (scrape_date, run_started_at, run_finished_at, ' +
      'layer_data_edited_at, registrations_seen, registrations_new, registrations_departed, ' +
      'license_page_attempted, license_page_failed, error_summary) ' +
      'VALUES (CAST(? AS DATE), CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), ' +
      'CAST(? AS TIMESTAMP), ?, ?, ?, ?, ?, ?)',
    [
      run.scrapeDate,
      run.runStartedAt,
      run.runFinishedAt,
      run.layerDataEditedAt,
      run.registrationsSeen,
      run.registrationsNew,
      run.registrationsDeparted,
      run.licensePageAttempted,
      run.licensePageFailed,
      run.errorSummary,
    ],
    [
      VARCHAR,
      VARCHAR,
      VARCHAR,
      VARCHAR,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      INTEGER,
      VARCHAR,
    ],
  );
}
