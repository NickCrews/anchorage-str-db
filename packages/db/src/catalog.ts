/**
 * Everything the database holds, in one list: the tables `schema.ts` declares
 * and the views `viewSchema.ts` declares.
 *
 * `connect` checks a file against this, and the viewer exposes exactly these
 * names, so neither keeps a list of its own to fall out of date.
 */

import { getTableName, getViewName, is, isView, type Table, type View } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from './schema.ts';
import * as viewSchema from './viewSchema.ts';

export const tables: readonly Table[] = Object.values<unknown>(schema).filter(
  (value): value is Table => is(value, PgTable),
);

export const views: readonly View[] = Object.values<unknown>(viewSchema).filter(isView);

export const tableNames: readonly string[] = tables.map(getTableName);

export const viewNames: readonly string[] = views.map(getViewName);
