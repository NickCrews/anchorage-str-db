import { useSql } from '@sqlrooms/duckdb';
import { useMemo } from 'react';
import { useRoomStore } from '../store';

/** Plain JS values: Arrow hands back BigInt for 64-bit integers, which charts cannot plot. */
function plain(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Runs `query` once the database and the estimate tables are ready, and
 * returns its rows as plain objects. DATE columns arrive as epoch
 * milliseconds.
 */
export function useRows<Row extends Record<string, unknown>>(
  query: string,
  { enabled = true }: { enabled?: boolean } = {},
): { rows: Row[]; isLoading: boolean; error: Error | null } {
  const ready = useRoomStore((s) => s.dataInit.status) === 'ready';
  const { data, isLoading, error } = useSql<Row>({ query, enabled: ready && enabled });
  const rows = useMemo(
    () =>
      (data?.toArray() ?? []).map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) out[key] = plain(value);
        return out as Row;
      }),
    [data],
  );
  return { rows, isLoading: !ready || isLoading, error };
}

/** The first row of `query`, or undefined while it loads. */
export function useRow<Row extends Record<string, unknown>>(query: string, options?: { enabled?: boolean }) {
  const { rows, ...rest } = useRows<Row>(query, options);
  return { row: rows[0] as Row | undefined, ...rest };
}
