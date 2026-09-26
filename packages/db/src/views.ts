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
  hostListingPortfolios,
  listingsActiveWithHost,
  listingsActiveWithRegistration,
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
  sql`COMMENT ON VIEW ${hostListingPortfolios} IS 'Listings per Airbnb host account per scrape date: the host''s Anchorage listing portfolio. Counts only listings inside the Municipality, so a host with 2 here and 40 elsewhere reads as 2 — their true portfolio is not recoverable from this database. No threshold marking a commercial host is stored.'`,
  sql`COMMENT ON COLUMN ${hostListingPortfolios.listingsActive} IS 'Listings held by this host that were live on scrape_date (seen within the retirement grace window ending that day).'`,
  sql`COMMENT ON COLUMN ${hostListingPortfolios.listingsEverSeen} IS 'Distinct listings observed under this host on or before scrape_date, active or inactive.'`,
  sql`COMMENT ON VIEW ${listingsActiveWithHost} IS 'listings_active plus the host''s name, tenure, and host_listing_portfolios counts as of the latest run. NULL when the host is unknown. Portfolio counts cover only listings inside the Municipality.'`,
  sql`COMMENT ON VIEW ${registrations} IS 'One row per STR registration the Municipal Clerk has published, with its latest license page. is_active means it was in the latest registry run; the Muni publishes only active registrations.'`,
  sql`COMMENT ON VIEW ${listingsActiveWithRegistration} IS 'listings_active plus the Municipal registration matching registration_id. Registration columns are NULL when there is no match.'`,
];

/**
 * Views under names `viewSchema.ts` no longer declares. `CREATE OR REPLACE
 * VIEW` cannot remove one, so a published database would carry a renamed
 * view's old name forever, still answering queries from a definition nothing
 * maintains — and `connect` refuses a database with a view it does not
 * declare. Every declared view is recreated straight after, so dropping these
 * first is safe.
 */
const DROPPED_VIEWS = [
  // Renamed to host_listing_portfolios: a portfolio needs to say whose it is
  // and what it counts.
  'host_portfolios',
];

/** The retired names, then every view in dependency order, then the comments on them. */
export function viewsSql(): string {
  return [
    ...DROPPED_VIEWS.map((name) => `DROP VIEW IF EXISTS ${name};`),
    ...VIEWS.map(createViewSql),
    ...COMMENTS.map((comment) => `${toSql(comment)};`),
  ].join('\n\n');
}
