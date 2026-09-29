/** The host-concentration card's queries, over each host's latest listing portfolio. */

import type { WasmSelection } from '@anchorage-str-db/db/rows';
import { qb } from '@anchorage-str-db/db/sql';
import { hostListingPortfolios, listingsActive } from '@anchorage-str-db/db/viewSchema';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

/**
 * Display cutoffs for "hosts with at least N active listings". The database
 * stores counts only; where an owner ends and an operator begins is left to
 * the reader, and the card says so.
 */
export const CUTOFFS = [2, 3, 5, 10, 20] as const;

/** The latest date `host_listing_portfolios` has counts for. */
const latestPortfolioDate = qb
  .select({ scrapeDate: sql<number>`max(${hostListingPortfolios.scrapeDate})`.as('scrape_date') })
  .from(hostListingPortfolios);

/**
 * Each host with active listings at the latest run: `host_listing_portfolios` cut down
 * to one date. Selected through the query builder, so the rows are still that
 * view's columns and the queries below read them as such under the name
 * `latest`.
 */
const latest = qb
  .select()
  .from(hostListingPortfolios)
  .where(
    and(
      eq(hostListingPortfolios.scrapeDate, latestPortfolioDate),
      gt(hostListingPortfolios.listingsActive, 0),
    ),
  )
  .as('latest');

/** Hosts by portfolio size, largest first, for the top-10 share. */
const ranked = qb.$with('ranked').as(
  qb
    .select({
      listingsActive: latest.listingsActive,
      rnk: sql<number>`row_number() OVER (ORDER BY ${latest.listingsActive} DESC, ${latest.hostId})`.as(
        'rnk',
      ),
    })
    .from(latest),
);

/** Active listings whose page was never read, so no host is known. */
const unknownHosts = qb
  .select({ unknownHost: sql<number>`count(*)::INT`.as('unknownHost') })
  .from(listingsActive)
  .where(isNull(listingsActive.hostId));

export const summaryFields = (cutoff: number) => ({
  hosts: sql<number>`count(*)::INT`.as('hosts'),
  hostsAtCutoff: sql<number>`count(*) FILTER (WHERE ${ranked.listingsActive} >= ${cutoff})::INT`.as(
    'hostsAtCutoff',
  ),
  attributed: sql<number>`coalesce(sum(${ranked.listingsActive}), 0)::INT`.as('attributed'),
  heldAtCutoff:
    sql<number>`coalesce(sum(${ranked.listingsActive}) FILTER (WHERE ${ranked.listingsActive} >= ${cutoff}), 0)::INT`.as(
      'heldAtCutoff',
    ),
  heldByTop10:
    sql<number>`coalesce(sum(${ranked.listingsActive}) FILTER (WHERE ${ranked.rnk} <= 10), 0)::INT`.as(
      'heldByTop10',
    ),
  unknownHost: sql<number>`${unknownHosts}`.as('unknownHost'),
});

export type SummaryRow = WasmSelection<ReturnType<typeof summaryFields>>;

export const summaryQuery = (cutoff: number) =>
  qb.with(ranked).select(summaryFields(cutoff)).from(ranked);

export const DISTRIBUTION_FIELDS = {
  bucket: sql<string>`CASE
        WHEN ${latest.listingsActive} >= 20 THEN '20+'
        WHEN ${latest.listingsActive} >= 10 THEN '10–19'
        WHEN ${latest.listingsActive} >= 5 THEN '5–9'
        WHEN ${latest.listingsActive} >= 3 THEN '3–4'
        ELSE ${latest.listingsActive}::VARCHAR
      END`.as('bucket'),
  listings: sql<number>`sum(${latest.listingsActive})::INT`.as('listings'),
};

export const DISTRIBUTION_QUERY = qb
  .select(DISTRIBUTION_FIELDS)
  .from(latest)
  .groupBy(sql`"bucket"`)
  .orderBy(sql`min(${latest.listingsActive})`);

export const trendFields = (cutoff: number) => ({
  scrapeDate: sql<number>`${hostListingPortfolios.scrapeDate}`.as('scrapeDate'),
  pctHeld: sql<number | null>`round(
        100.0 * coalesce(
          sum(${hostListingPortfolios.listingsActive})
            FILTER (WHERE ${hostListingPortfolios.listingsActive} >= ${cutoff}),
          0
        ) / nullif(sum(${hostListingPortfolios.listingsActive}), 0),
        1
      )::DOUBLE`.as('pctHeld'),
});

export type TrendRow = WasmSelection<ReturnType<typeof trendFields>>;

export const trendQuery = (cutoff: number) =>
  qb
    .select(trendFields(cutoff))
    .from(hostListingPortfolios)
    .groupBy(hostListingPortfolios.scrapeDate)
    .orderBy(asc(hostListingPortfolios.scrapeDate));
