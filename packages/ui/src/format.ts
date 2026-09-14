// DuckDB DATE columns come back from useSql as epoch-millisecond numbers,
// not Date instances. They are calendar dates, so format them in UTC.

export const shortDate = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export const monthLabel = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');
