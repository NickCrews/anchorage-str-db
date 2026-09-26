/**
 * Attaching the database file and exposing what it holds, as the viewer does
 * in the browser and the query test does in Node.
 */

import { tableNames, viewNames } from '@anchorage-str-db/db/catalog';
import { toSql } from '@anchorage-str-db/db/sql';
import { sql } from 'drizzle-orm';

/**
 * Everything the attached database holds, exposed in the main schema: the
 * tables `@anchorage-str-db/db` declares and the views it builds over them.
 * The list is the schema's, not one kept here, so a view added to the database
 * shows up in the viewer without an edit, and its type is the names
 * themselves rather than `string`.
 *
 * Read `calendar_current` rather than `airbnb_calendar_status` for current
 * availability, and `listings` rather than `airbnb_listing_observations` for
 * what a listing is now.
 */
export const LAKE_TABLES = [...tableNames, ...viewNames];

const ATTACHED_SCHEMA = 'str';

/**
 * Attaches `file` read-only and creates a main-schema view for each name in
 * `LAKE_TABLES`, so the viewer's queries name relations without a schema.
 */
export function attachSql(file: string): string[] {
  return [
    toSql(sql`ATTACH ${file} AS ${sql.identifier(ATTACHED_SCHEMA)} (READ_ONLY)`),
    ...LAKE_TABLES.map((table) =>
      toSql(sql`CREATE OR REPLACE VIEW ${sql.identifier(table)} AS
        SELECT * FROM ${sql.identifier(ATTACHED_SCHEMA)}.${sql.identifier(table)}`),
    ),
  ];
}
