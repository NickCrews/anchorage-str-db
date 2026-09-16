/**
 * The `CREATE OR REPLACE VIEW` script `connect` runs on every open.
 *
 * Each statement is one of the views declared in `viewSchema.ts`, rendered
 * from the query declared with it, in the order they are listed there: each
 * view reads only the tables and the views before it. Recreating them on
 * connect is what lets a change to a view land without a migration.
 */

import { getViewName, sql } from 'drizzle-orm';
import { getViewConfig, type PgView } from 'drizzle-orm/pg-core';

import { toSql } from './sql.ts';
import {
  hostPortfolios,
  listingsCurrentWithHost,
  listingsCurrentWithRegistration,
  registrations,
  VIEWS,
} from './viewSchema.ts';

function createViewSql(view: PgView): string {
  const { query } = getViewConfig(view);
  if (query === undefined) {
    throw new Error(`\`${getViewName(view)}\` has no query to create it from.`);
  }
  return `CREATE OR REPLACE VIEW ${getViewName(view)} AS ${toSql(query)};`;
}

/**
 * Notes stored in the file itself, so readers of the published `.duckdb` see
 * the scope of what they are reading.
 */
const COMMENTS = [
  sql`COMMENT ON VIEW ${hostPortfolios} IS 'Listings per Airbnb host account per scrape date. Counts only listings in the Anchorage search area, not a host''s listings elsewhere. No owner/operator threshold is stored.'`,
  sql`COMMENT ON COLUMN ${hostPortfolios.listingsLive} IS 'Listings held by this host that were live on scrape_date (seen within the retirement grace window ending that day).'`,
  sql`COMMENT ON COLUMN ${hostPortfolios.listingsEverSeen} IS 'Distinct listings observed under this host on or before scrape_date, live or retired.'`,
  sql`COMMENT ON VIEW ${listingsCurrentWithHost} IS 'listings_current plus the host''s name, tenure, and host_portfolios counts as of the latest run. NULL when the host is unknown. Portfolio counts cover only the Anchorage search area.'`,
  sql`COMMENT ON VIEW ${registrations} IS 'One row per STR registration the Municipal Clerk has published, with its latest license page. is_current means it was in the latest registry run; the Muni publishes only active registrations.'`,
  sql`COMMENT ON VIEW ${listingsCurrentWithRegistration} IS 'listings_current plus the Municipal registration matching str_registration_id. Registration columns are NULL when there is no match.'`,
];

/** Every view, in dependency order, then the comments on them. */
export function viewsSql(): string {
  return [...VIEWS.map(createViewSql), ...COMMENTS.map((comment) => `${toSql(comment)};`)].join(
    '\n\n',
  );
}
