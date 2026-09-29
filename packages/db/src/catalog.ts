/**
 * Everything the database holds, in one list: the tables `schema.ts` declares
 * and the views `viewSchema.ts` declares.
 *
 * `connect` checks a file against this, and the viewer exposes exactly these
 * names, so neither keeps a list of its own to fall out of date.
 *
 * The lists keep the types of what is in them rather than widening to `Table`
 * and `View`: `tables` is a union of the declared tables, so a caller reading
 * one still has its columns, and `tableNames` is a union of the names
 * themselves (`'airbnb_listings' | ...`) rather than `string`.
 */

import { getTableName, getViewName, is, type Table } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from './schema.ts';
import { VIEWS } from './viewSchema.ts';

/** A table `schema.ts` exports, as declared. */
type SchemaTable = Extract<(typeof schema)[keyof typeof schema], Table>;

/** A view `viewSchema.ts` declares, as declared. */
type SchemaView = (typeof VIEWS)[number];

export const tables: readonly SchemaTable[] = Object.values<unknown>(schema).filter(
  (value): value is SchemaTable => is(value, PgTable),
);

/** In the order `viewSchema.ts` lists them, which is the order they are created in. */
export const views: readonly SchemaView[] = VIEWS;

export const tableNames: readonly SchemaTable['_']['name'][] = tables.map(getTableName);

export const viewNames: readonly SchemaView['_']['name'][] = views.map(getViewName);
