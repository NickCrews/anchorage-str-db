// DuckDB DATE columns come back from useSql as epoch-millisecond numbers,
// not Date instances. They are calendar dates, so format them in UTC.

export const shortDate = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export const longDate = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export const monthLabel = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });

export const monthName = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** `YYYY-MM-DD` for a SQL DATE literal. */
export const isoDate = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');

export const pct1 = (share: number | null | undefined) =>
  share == null || Number.isNaN(share) ? '—' : `${Math.round(100 * share)}%`;

export const int = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US');

/** `$1,234`, or `$1.2M` / `$34k` when `compact`. */
export const money = (n: number | null | undefined, compact = false) => {
  if (n == null || Number.isNaN(n)) return '—';
  if (compact && Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (compact && Math.abs(n) >= 10_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
};
