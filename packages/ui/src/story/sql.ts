/**
 * Listing-months joined to their listings for one month, alias `m` for the
 * month and `l` for the listing. `where` narrows it, e.g. to a chapter's
 * selected listings.
 */
export const listingMonthsSql = (monthSql: string, where = 'true') => `
  SELECT m.*, l.* EXCLUDE (listing_id)
  FROM est_listing_months m
  JOIN est_listings l USING (listing_id)
  WHERE m.month = DATE '${monthSql}' AND ${where}
`;

/** The months with calendar data, oldest first. */
export const MONTHS_SQL = `
  SELECT month AS "month", strftime(month, '%Y-%m-%d') AS "monthSql"
  FROM est_listing_months
  GROUP BY month
  ORDER BY month
`;
