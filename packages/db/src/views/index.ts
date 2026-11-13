/**
 * The views, recreated on every `connect`. Everything downstream reads these
 * rather than the tables in `../schema`.
 *
 * One file per source holds the views over that source's tables alone, and
 * `combined.ts` the views that join sources. Cleaning (the `'None'` business
 * name, the no-match placeholder coordinate) happens in the views, so the raw
 * tables can always be re-derived.
 *
 * Views are not in the Drizzle schema: they use DuckDB syntax drizzle-kit
 * cannot express, and recreating them on connect applies a change without a
 * migration.
 */

import { airbnbViewsSql } from './airbnb.ts';
import { COMBINED_VIEWS_SQL } from './combined.ts';
import { MUNI_LICENSE_VIEWS_SQL } from './muniLicenses.ts';

export { RETIREMENT_GRACE_DAYS } from './airbnb.ts';
export { CITYVIEW_LICENSE_ID_SQL, NO_MATCH_GEOCODED_ADDRESS } from './combined.ts';
export { ACTIVE_ISSUANCE_STATUSES, SHORT_TERM_RENTALS, STR_CERTIFICATE } from './muniLicenses.ts';

/**
 * Views under names this file no longer creates. `CREATE OR REPLACE VIEW`
 * cannot remove one, so a published database would carry a renamed view's old
 * name forever, still answering queries from a definition nothing maintains.
 * Everything below is recreated straight after, so dropping it here is safe.
 */
const DROPPED_VIEWS_SQL = `
-- Renamed to host_listing_portfolios: a portfolio needs to say whose it is
-- and what it counts.
DROP VIEW IF EXISTS host_portfolios;
-- Replaced by licenses, which leaves out ids whose latest read is hidden.
DROP VIEW IF EXISTS license_pages_latest;
`;

/**
 * Every view, in dependency order: the per-source views first, then
 * `combined.ts`, whose `registrations` reads `licenses` and `listings_active`.
 */
export function viewsSql(): string {
  return DROPPED_VIEWS_SQL + airbnbViewsSql() + MUNI_LICENSE_VIEWS_SQL + COMBINED_VIEWS_SQL;
}
