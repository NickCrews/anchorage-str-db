/**
 * The table each chapter cross-filters: one row per listing with calendar
 * data in the chapter's month, its attributes and its month's estimates
 * under the reader's chosen model. Column names are the table headers the
 * reader sees, so they are plain words; columns named in `_snake_case` are
 * for charts and not shown.
 */
import type { Model } from '../model';

/** Values are capped for histograms so a long right tail does not flatten them. */
export const REVENUE_CAP = 8000;
export const RATE_CAP = 1000;

/**
 * One table per chapter, model and month. Mosaic caches results by query
 * text, so a table rebuilt under the same name would keep serving the old
 * rows.
 */
export const xfTableName = (chapterId: string, model: Model, month: string) =>
  `xf_${chapterId}_${model}_${month.replaceAll('-', '')}`;

/** The est_listing_months columns behind each model. */
const MODEL_COLUMNS: Record<Model, { revenue: string; booked: string; occupancy: string }> = {
  low: { revenue: 'revenue_low', booked: 'nights_booked_low', occupancy: 'occupancy_low' },
  middle: { revenue: 'revenue', booked: 'nights_booked', occupancy: 'occupancy' },
  high: { revenue: 'revenue_high', booked: 'nights_booked_high', occupancy: 'occupancy_high' },
};

/** Registration values, in the order charts list them. */
export const REGISTRATION_VALUES = ['Registered', 'Lapsed', 'Number not on file', 'None shown'] as const;

/** Whether the owner of record claims the property as their home, as `est_listings l` SQL. */
export const LIVES_THERE_SQL = `CASE
  WHEN l.owner_name IS NULL THEN 'Owner not known'
  WHEN l.owner_occupied_exemption THEN 'Owner lives there'
  ELSE 'Owner lives elsewhere'
END`;

/**
 * Airbnb listing and host ids exceed 2^53, which Mosaic's Arrow reader
 * refuses to turn into JS numbers, so the table holds them as text.
 */
export const buildXfTableSql = (table: string, month: string, model: Model) => {
  const c = MODEL_COLUMNS[model];
  return `
  CREATE OR REPLACE TABLE ${table} AS
  WITH host_names AS (
    SELECT host_id, name AS host_name
    FROM hosts
    QUALIFY row_number() OVER (PARTITION BY host_id ORDER BY valid_from DESC) = 1
  )
  SELECT
    l.listing_id::VARCHAR AS listing_id,
    l.name AS "listing",
    l.listing_kind AS "type",
    l.area AS "area",
    l.community_council AS "community council",
    CASE
      WHEN l.bedrooms ILIKE 'studio%' THEN 'Studio'
      WHEN l.bedroom_count IS NULL THEN 'Not listed'
      WHEN l.bedroom_count >= 5 THEN '5+'
      ELSE l.bedroom_count::VARCHAR
    END AS "bedrooms",
    l.guest_capacity AS "sleeps",
    coalesce(h.host_name, '(unknown)') AS "host",
    count(*) OVER (PARTITION BY l.host_id) AS "host's listings",
    CASE
      WHEN l.registration_id IS NULL THEN 'None shown'
      WHEN l.registration_is_active IS NULL THEN 'Number not on file'
      WHEN NOT l.registration_is_active THEN 'Lapsed'
      ELSE 'Registered'
    END AS "registration",
    l.owner_name AS "owner",
    l.owner_kind AS "owner type",
    l.owner_mailing AS "owner's mail goes to",
    ${LIVES_THERE_SQL} AS "owner lives there?",
    round(m.${c.revenue}) AS "revenue",
    round(100 * m.${c.occupancy}) AS "occupancy %",
    round(m.nightly_rate) AS "nightly price",
    m.${c.booked} AS "nights booked",
    m.nights_available AS "nights open",
    m.nights - m.nights_available - m.${c.booked} AS "nights closed",
    least(m.${c.revenue}, ${REVENUE_CAP}) AS _revenue_capped,
    least(m.nightly_rate, ${RATE_CAP}) AS _price_capped,
    round(100 * m.${c.occupancy}) AS _occupancy,
    l.host_id::VARCHAR AS host_id,
    l.url,
    ST_AsWKB(ST_Point(l.lng, l.lat)) AS geom
  FROM est_listing_months m
  JOIN est_listings l USING (listing_id)
  LEFT JOIN host_names h USING (host_id)
  WHERE m.month = DATE '${month}'
`;
};

/** Columns the table shows, per chapter. */
export const TABLE_COLUMNS = {
  revenue: ['listing', 'type', 'area', 'bedrooms', 'revenue', 'nights booked', 'nightly price', 'host'],
  host: ['listing', 'host', "host's listings", 'type', 'area', 'revenue', 'nights booked'],
  rate: ['listing', 'type', 'area', 'bedrooms', 'nightly price', 'sleeps', 'revenue'],
  occupancy: ['listing', 'type', 'area', 'occupancy %', 'nights booked', 'nights closed', 'nights open'],
  supply: ['listing', 'type', 'area', 'registration', 'bedrooms', 'host'],
  incentive: ['listing', 'type', 'bedrooms', 'owner lives there?', 'revenue', 'area'],
  tourism: ['listing', 'type', 'area', 'sleeps', 'nights booked', 'revenue'],
  locals: ['listing', 'type', 'community council', 'owner lives there?', 'nights closed', 'nights booked', "owner's mail goes to"],
  tax: ['listing', 'type', 'area', 'revenue', 'nights booked', 'host'],
  owners: ['listing', 'owner', 'owner type', "owner's mail goes to", 'type', 'area', 'revenue'],
  baseline: ['listing', 'type', 'area', 'registration', 'owner lives there?', 'owner type', 'revenue'],
} as const;
