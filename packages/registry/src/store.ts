/**
 * DuckDB schema and merge logic for the municipal registry.
 *
 * - `str_registration_versions`: SCD2 on `record_key`. One row per
 *   registration per distinct attribute set, with `valid_from`/`valid_to`.
 * - `registry_runs`: one row per run.
 *
 * **Change-only, not a daily snapshot.** The layer holds a few thousand rows
 * whose contents move a handful of times a year — a registration is issued,
 * renewed, or lapses — so a daily snapshot would be ~99.9% rows identical to
 * the day before. The whole history of a registration is a short list of
 * intervals. This is the same choice `calendar_status` makes on the Airbnb
 * side, for the same reason, and the opposite of `listing_observations`,
 * which is stored daily because its rows carry values (price, rating, review
 * count) that genuinely differ every day. See
 * `docs/proposals/muni-registry-integration.md` for the row-count arithmetic.
 *
 * **Absence is a fact, so it is recorded.** Change-only storage has one
 * trap: with no daily row, "unchanged" and "not looked at" are the same
 * silence. Two things close it. Every run reads the layer in full, so a
 * record that stops appearing has its interval closed — a removal, dated.
 * And `registry_runs` records every run, so a gap in the history is
 * visible as a day with no run rather than read as a day when nothing
 * changed.
 *
 * The database may be the published `anchorage_str.duckdb` or a file of its
 * own: these tables are new names, created with `CREATE TABLE IF NOT
 * EXISTS`, and nothing here reads or writes the scraper's. When the
 * scraper's `listings` view is present, `connect` adds the join views that
 * match the two sides on the registration number.
 */

import {
  BIGINT,
  DOUBLE,
  INTEGER,
  LIST,
  VARCHAR,
  listValue,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';

import * as config from './config.ts';
import type { IsoDate } from './dates.ts';
import { appendRow, Database } from './db.ts';
import { log } from './log.ts';
import type { RegistrationRecord } from './records.ts';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS str_registration_versions (
    -- The normalized registration number, which is the identity of a
    -- registration; see \`records.ts\` for the fallback when a record has
    -- none of its own.
    record_key VARCHAR NOT NULL,
    -- NULL when the layer's number was blank or unreadable. Normalized:
    -- uppercase, letters and digits only. The join key to
    -- \`listings.str_registration_id\`.
    registration_id VARCHAR,
    -- The number as the Municipality publishes it, punctuation and all.
    registration_label VARCHAR,
    -- The layer's OBJECTID. Identifies the row only until the publisher
    -- rebuilds the layer, so it is stored for tracing, never joined on.
    object_id BIGINT,

    status VARCHAR,
    registration_type VARCHAR,
    address VARCHAR,
    unit VARCHAR,
    zip VARCHAR,
    -- The join key to the Anchorage parcel database, when the layer has one.
    parcel_id VARCHAR,
    operator_name VARCHAR,

    issued_date DATE,
    expires_date DATE,
    -- The layer's own last-edited stamp, when it publishes one. Not part of
    -- the version hash: a republish moves it for every row at once.
    edited_date DATE,

    location_lat DOUBLE,
    location_lng DOUBLE,

    -- Every attribute the layer returned, verbatim. The mapped columns above
    -- are a convenience derived from this; a column \`fields.ts\` did not
    -- recognize is still here and can be mapped later without re-scraping,
    -- which a current-state layer with no history does not otherwise allow.
    attributes JSON NOT NULL,
    attrs_hash VARCHAR NOT NULL,

    valid_from DATE NOT NULL,
    -- NULL while current. Set to the run date when the record changed or
    -- stopped appearing in the layer.
    valid_to DATE,
    is_current BOOLEAN NOT NULL,

    PRIMARY KEY (record_key, valid_from)
);

CREATE TABLE IF NOT EXISTS registry_runs (
    refresh_date DATE NOT NULL,
    run_started_at TIMESTAMP NOT NULL,
    run_finished_at TIMESTAMP,
    service_url VARCHAR,
    -- The layer's editingInfo.lastEditDate: when the Municipality last
    -- touched the data, recorded every run whether or not a record moved.
    -- The cheapest measure of how often this source actually changes.
    layer_last_edit TIMESTAMP,
    records_seen INTEGER,
    records_new INTEGER,
    records_changed INTEGER,
    records_removed INTEGER,
    -- Layer fields no column in \`fields.ts\` claimed.
    unmapped_fields VARCHAR[],
    error_summary VARCHAR
);
`;

/**
 * `listings.str_registration_id` reduced to the same key as
 * `registration_id`: uppercase, letters and digits only, and NULL unless it
 * contains a digit, so "N/A" and "pending" do not join to each other.
 *
 * This must agree with `normalizeRegistrationId` in `fields.ts`, which does
 * the same to the municipal side before storing it.
 * `test/fields.test.ts` asserts the two agree case by case.
 */
export const REGISTRATION_KEY_SQL = `
CREATE OR REPLACE MACRO registration_key(value) AS (
    CASE
        WHEN regexp_matches(upper(regexp_replace(value, '[^A-Za-z0-9]', '', 'g')), '[0-9]')
        THEN upper(regexp_replace(value, '[^A-Za-z0-9]', '', 'g'))
    END
);
`;

export const VIEWS_SQL = `
-- One row per registration version, with the dates derived rather than
-- stored, so a fix to this logic needs no backfill of the archive.
CREATE OR REPLACE VIEW str_registrations AS
SELECT
    v.* EXCLUDE (is_current),
    a.first_seen_date,
    -- When the registration left the layer, NULL while it is still there.
    -- A version closed by a change is succeeded by another; the last version
    -- of a registration that is gone is not.
    CASE WHEN NOT a.in_layer THEN a.last_valid_to END AS removed_date,
    v.is_current
FROM str_registration_versions v
JOIN (
    SELECT
        record_key,
        min(valid_from) AS first_seen_date,
        max(valid_to) AS last_valid_to,
        bool_or(is_current) AS in_layer
    FROM str_registration_versions
    GROUP BY record_key
) a USING (record_key);

CREATE OR REPLACE VIEW str_registrations_current AS
SELECT * FROM str_registrations WHERE is_current;
`;

/**
 * Added only when the scraper's tables share the file. DuckDB resolves a
 * view's references when it is created, so creating these against a
 * registry-only database would fail.
 */
export const JOIN_VIEWS_SQL = `
-- Every current listing beside the registration it claims, and every current
-- registration beside the listings claiming it: a FULL JOIN, because both
-- directions are the question. A listing with no match is either unregistered
-- or has typed something that is not its number; a registration with no match
-- is registered but not advertised on Airbnb (Vrbo, direct booking, a lapsed
-- listing, or a room this project has not found).
--
-- The match is many-to-many on purpose: one registration can carry several
-- Airbnb rooms, and several listings can quote the same number.
CREATE OR REPLACE VIEW listing_registration_matches AS
SELECT
    l.listing_id,
    l.str_registration_id AS listing_registration_text,
    registration_key(l.str_registration_id) AS listing_registration_key,
    l.name AS listing_name,
    l.host_id,
    l.room_type,
    l.location_lat AS listing_lat,
    l.location_lng AS listing_lng,
    l.location_is_exact AS listing_location_is_exact,
    r.record_key,
    r.registration_id,
    r.registration_label,
    r.status AS registration_status,
    r.registration_type,
    r.address AS registration_address,
    r.parcel_id,
    r.operator_name,
    r.issued_date,
    r.expires_date,
    r.location_lat AS registration_lat,
    r.location_lng AS registration_lng,
    CASE
        WHEN l.listing_id IS NULL THEN 'registration_only'
        WHEN r.record_key IS NULL AND registration_key(l.str_registration_id) IS NULL
            THEN 'listing_unregistered'
        WHEN r.record_key IS NULL THEN 'listing_number_unmatched'
        ELSE 'matched'
    END AS match_kind
FROM listings_current l
FULL OUTER JOIN str_registrations_current r
    ON registration_key(l.str_registration_id) = r.registration_id;

-- The coverage summary: how many listings carry a number, how many of those
-- numbers are in the registry, and how much of the registry is on Airbnb.
CREATE OR REPLACE VIEW listing_registration_coverage AS
SELECT
    match_kind,
    count(DISTINCT listing_id) AS listings,
    count(DISTINCT record_key) AS registrations
FROM listing_registration_matches
GROUP BY match_kind;
`;

/** Raised for a database whose schema this code cannot read. */
export class LegacySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacySchemaError';
  }
}

async function hasRelation(db: Database, name: string): Promise<boolean> {
  const count = await db.count(
    'SELECT count(*) FROM (SELECT table_name AS n FROM duckdb_tables() ' +
      'UNION ALL SELECT view_name AS n FROM duckdb_views()) WHERE n = ?',
    [name],
  );
  return count > 0;
}

/**
 * Open (or create) the database and refresh the views.
 *
 * Safe against the scraper's published file: it only adds its own tables.
 * The join views appear when `listings_current` is there to join to, and are
 * dropped when it is not, so a file that loses one side does not keep a view
 * that cannot be read.
 */
export async function connect(path: string): Promise<Database> {
  const db = await Database.open(path);
  await rejectLegacySchema(db);
  await db.run(SCHEMA_SQL);
  await db.run(REGISTRATION_KEY_SQL);
  await db.run(VIEWS_SQL);
  if (await hasRelation(db, 'listings_current')) {
    await db.run(JOIN_VIEWS_SQL);
  } else {
    await db.run('DROP VIEW IF EXISTS listing_registration_coverage');
    await db.run('DROP VIEW IF EXISTS listing_registration_matches');
    log.debug('no `listings_current` in this database: skipping the join views');
  }
  return db;
}

/**
 * Throw on a database this code cannot merge into.
 *
 * Only one shape is rejected: a `str_registration_versions` without
 * `record_key`, which would be a pre-SCD2 table whose rows carry no identity
 * to attach an interval to.
 */
async function rejectLegacySchema(db: Database): Promise<void> {
  const columns = await db.rows<{ column_name: string }>(
    "SELECT column_name FROM duckdb_columns() WHERE table_name = 'str_registration_versions'",
  );
  if (columns.length === 0) return;
  for (const required of ['record_key', 'attrs_hash', 'attributes']) {
    if (!columns.some((row) => row.column_name === required)) {
      throw new LegacySchemaError(
        `\`str_registration_versions\` has no \`${required}\` column. There is no migration: ` +
          'drop the table and re-run, which costs only the history this package has collected.',
      );
    }
  }
}

// --------------------------------------------------------------------------
// merge

export interface MergeStats {
  seen: number;
  /** Records whose key had never been seen before. */
  new: number;
  /** Records whose attributes differ from their current version, new ones included. */
  changed: number;
  /** Registrations that were current and are no longer in the layer. */
  removed: number;
}

/** Raised when an extract is too much smaller than the last one to trust. */
export class RegistryShrankError extends Error {
  constructor(seen: number, previous: number) {
    super(
      `refusing to merge: the extract has ${seen} records against ${previous} current ` +
        `(a drop of ${Math.round((1 - seen / previous) * 100)}%, over the ` +
        `${Math.round(config.MAX_SHRINK_RATE * 100)}% allowed). Merging would close the ` +
        'missing registrations as removed. Re-run; if the layer really did shrink, raise ' +
        'MAX_SHRINK_RATE for the run.',
    );
    this.name = 'RegistryShrankError';
  }
}

/** Raised for a run dated before data already in the table. */
export class OutOfOrderRunError extends Error {
  constructor(refreshDate: IsoDate, latest: string) {
    super(
      `refusing to merge a run dated ${refreshDate}: the table already holds rows dated ` +
        `${latest}. An SCD2 merge appends to the end of the history and cannot be replayed ` +
        'into the middle of it.',
    );
    this.name = 'OutOfOrderRunError';
  }
}

const STAGING_COLUMNS = [
  ['record_key', VARCHAR],
  ['registration_id', VARCHAR],
  ['registration_label', VARCHAR],
  ['object_id', BIGINT],
  ['status', VARCHAR],
  ['registration_type', VARCHAR],
  ['address', VARCHAR],
  ['unit', VARCHAR],
  ['zip', VARCHAR],
  ['parcel_id', VARCHAR],
  ['operator_name', VARCHAR],
  // Dates are staged as text and cast in SQL, which accepts an ISO date and
  // NULL alike; the appender would need a typed date value per column.
  ['issued_date', VARCHAR],
  ['expires_date', VARCHAR],
  ['edited_date', VARCHAR],
  ['location_lat', DOUBLE],
  ['location_lng', DOUBLE],
  ['attributes', VARCHAR],
  ['attrs_hash', VARCHAR],
] as const satisfies ReadonlyArray<readonly [string, DuckDBType]>;

const STAGING_TYPES = STAGING_COLUMNS.map(([, type]) => type);

/** Column names as SQL, paired with `STAGING_TYPES` by position. */
const STAGING_SQL_TYPES: Record<string, string> = {
  record_key: 'VARCHAR',
  registration_id: 'VARCHAR',
  registration_label: 'VARCHAR',
  object_id: 'BIGINT',
  status: 'VARCHAR',
  registration_type: 'VARCHAR',
  address: 'VARCHAR',
  unit: 'VARCHAR',
  zip: 'VARCHAR',
  parcel_id: 'VARCHAR',
  operator_name: 'VARCHAR',
  issued_date: 'VARCHAR',
  expires_date: 'VARCHAR',
  edited_date: 'VARCHAR',
  location_lat: 'DOUBLE',
  location_lng: 'DOUBLE',
  attributes: 'VARCHAR',
  attrs_hash: 'VARCHAR',
};

const STAGING_DDL = `CREATE OR REPLACE TEMP TABLE stg_registrations (${STAGING_COLUMNS.map(
  ([name]) => `${name} ${STAGING_SQL_TYPES[name]}`,
).join(', ')})`;

/** The insert's column list, with the staged text dates cast back to DATE. */
const INSERT_COLUMNS = STAGING_COLUMNS.map(([name]) => name);
const INSERT_SELECT = INSERT_COLUMNS.map((name) =>
  name.endsWith('_date')
    ? `CAST(s.${name} AS DATE) AS ${name}`
    : name === 'attributes'
      ? `CAST(s.${name} AS JSON) AS ${name}`
      : `s.${name}`,
).join(', ');

function values(record: RegistrationRecord): DuckDBValue[] {
  return [
    record.recordKey,
    record.registrationId,
    record.registrationLabel,
    record.objectId === null ? null : BigInt(record.objectId),
    record.status,
    record.registrationType,
    record.address,
    record.unit,
    record.zip,
    record.parcelId,
    record.operatorName,
    record.issuedDate,
    record.expiresDate,
    record.editedDate,
    record.locationLat,
    record.locationLng,
    JSON.stringify(record.attributes),
    record.attrsHash,
  ];
}

/**
 * SCD2-merge one extract.
 *
 * Re-running a date is idempotent: the merge first undoes anything an
 * earlier run wrote for that date, by dropping the versions it opened and
 * reopening the ones it closed. That is exact because a merge is the only
 * thing that writes `valid_from` or `valid_to`, and it writes only its own
 * date.
 *
 * Everything here happens in the caller's transaction. Halfway through,
 * intervals are closed and their replacements are not yet written, which
 * reads as a registry that lost those records.
 */
export async function mergeRegistrations(
  db: Database,
  refreshDate: IsoDate,
  records: readonly RegistrationRecord[],
): Promise<MergeStats> {
  const latest = await db.value(
    'SELECT max(greatest(valid_from, coalesce(valid_to, valid_from))) FROM str_registration_versions',
  );
  if (typeof latest === 'string' && latest > refreshDate) {
    throw new OutOfOrderRunError(refreshDate, latest);
  }

  // Undo an earlier merge for this same date, so a re-run replaces it.
  await db.run('DELETE FROM str_registration_versions WHERE valid_from = CAST(? AS DATE)', [
    refreshDate,
  ]);
  await db.run(
    'UPDATE str_registration_versions SET valid_to = NULL, is_current = true ' +
      'WHERE valid_to = CAST(? AS DATE)',
    [refreshDate],
  );

  const previous = await db.count(
    'SELECT count(*) FROM str_registration_versions WHERE is_current',
  );
  if (
    previous >= config.SHRINK_GUARD_MIN_RECORDS &&
    records.length < previous * (1 - config.MAX_SHRINK_RATE)
  ) {
    throw new RegistryShrankError(records.length, previous);
  }

  await db.run(STAGING_DDL);
  if (records.length > 0) {
    const staging = await db.appender('stg_registrations');
    for (const record of records) appendRow(staging, STAGING_TYPES, values(record));
    staging.flushSync();
    staging.closeSync();
  }

  const changedKeys = await db.rows<{ record_key: string; first_time: boolean }>(`
    SELECT s.record_key, c.record_key IS NULL AS first_time
    FROM stg_registrations s
    LEFT JOIN str_registration_versions c ON c.record_key = s.record_key AND c.is_current
    WHERE c.record_key IS NULL OR c.attrs_hash != s.attrs_hash
  `);
  const removed = await db.count(`
    SELECT count(*) FROM str_registration_versions c
    WHERE c.is_current AND c.record_key NOT IN (SELECT record_key FROM stg_registrations)
  `);

  // Close the interval of everything that changed or disappeared. A changed
  // record gets a replacement below; a disappeared one does not, which is
  // what makes it a removal.
  await db.run(
    `
    UPDATE str_registration_versions SET valid_to = CAST(? AS DATE), is_current = false
    WHERE is_current AND record_key NOT IN (
        SELECT s.record_key FROM stg_registrations s
        JOIN str_registration_versions c ON c.record_key = s.record_key AND c.is_current
        WHERE c.attrs_hash = s.attrs_hash
    )
    `,
    [refreshDate],
  );

  await db.run(
    `
    INSERT INTO str_registration_versions (${INSERT_COLUMNS.join(', ')}, valid_from, valid_to, is_current)
    SELECT ${INSERT_SELECT}, CAST(? AS DATE), NULL, true
    FROM stg_registrations s
    WHERE s.record_key IN (
        SELECT record_key FROM stg_registrations
        EXCEPT
        SELECT c.record_key FROM str_registration_versions c
        WHERE c.valid_to IS NULL AND c.is_current
    )
    `,
    [refreshDate],
  );
  await db.run('DROP TABLE stg_registrations');

  return {
    seen: records.length,
    new: changedKeys.filter((row) => row.first_time).length,
    changed: changedKeys.length,
    removed,
  };
}

// --------------------------------------------------------------------------
// run log

export interface RunRow {
  refreshDate: IsoDate;
  runStartedAt: string;
  runFinishedAt: string | null;
  serviceUrl: string | null;
  layerLastEdit: string | null;
  recordsSeen: number | null;
  recordsNew: number | null;
  recordsChanged: number | null;
  recordsRemoved: number | null;
  unmappedFields: readonly string[] | null;
  errorSummary: string | null;
}

const RUN_PARAM_TYPES = [
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  VARCHAR,
  INTEGER,
  INTEGER,
  INTEGER,
  INTEGER,
  LIST(VARCHAR),
  VARCHAR,
] satisfies DuckDBType[];

export async function logRun(db: Database, run: RunRow): Promise<void> {
  await db.run(
    'INSERT INTO registry_runs ' +
      '(refresh_date, run_started_at, run_finished_at, service_url, layer_last_edit, ' +
      ' records_seen, records_new, records_changed, records_removed, unmapped_fields, ' +
      ' error_summary) ' +
      'VALUES (CAST(? AS DATE), CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), ?, ' +
      ' CAST(? AS TIMESTAMP), ?, ?, ?, ?, ?, ?)',
    [
      run.refreshDate,
      run.runStartedAt,
      run.runFinishedAt,
      run.serviceUrl,
      run.layerLastEdit,
      run.recordsSeen,
      run.recordsNew,
      run.recordsChanged,
      run.recordsRemoved,
      run.unmappedFields === null ? null : listValue([...run.unmappedFields]),
      run.errorSummary,
    ],
    RUN_PARAM_TYPES,
  );
}
