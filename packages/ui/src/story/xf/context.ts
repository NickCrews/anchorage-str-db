import type { Selection } from '@sqlrooms/mosaic';
import { createContext, useContext } from 'react';

export interface XfContextValue {
  /** The chapter's cross-filter table, one row per listing for `month`. */
  table: string;
  /** `YYYY-MM-DD`, the first of the month the table holds. */
  month: string;
  /** Changes whenever the table is rebuilt (a new month or model), for keys of clients that read it. */
  version: string;
  selection: Selection;
  /** SQL for the current selection over `table`, `true` when nothing is selected. */
  predicate: string;
  /** Number of clauses in the selection. */
  filters: number;
  clear: () => void;
  /** The listing whose details are open, from a map or table click, as text: listing ids exceed 2^53. */
  picked: string | null;
  setPicked: (listingId: string | null) => void;
}

/** Null until the chapter's table is built for its month. */
export const XfContext = createContext<XfContextValue | null>(null);

export function useXfMaybe(): XfContextValue | null {
  return useContext(XfContext);
}

export function useXf(): XfContextValue {
  const value = useContext(XfContext);
  if (!value) throw new Error('useXf before the chapter table is built');
  return value;
}

/**
 * SQL restricting `alias.listing_id` to the listings the chapter's selection
 * keeps, for charts that query other tables.
 */
export const selectedListingsSql = (xf: Pick<XfContextValue, 'table' | 'predicate'>, alias: string) =>
  xf.predicate === 'true'
    ? `${alias}.listing_id IN (SELECT listing_id::BIGINT FROM ${xf.table})`
    : `${alias}.listing_id IN (SELECT listing_id::BIGINT FROM ${xf.table} WHERE ${xf.predicate})`;
