import { useMemo } from 'react';
import { monthLabel } from '../format';
import { useRows } from '../lib/query';
import { useStory } from './context';
import { MONTHS_SQL } from './sql';

export interface MonthOption {
  value: string;
  label: string;
  epochMs: number;
  /** A run before its first night and a run after its last: every night is settled. */
  complete: boolean;
  /** Its first night is before the latest run. Later months hold only what is on the books. */
  started: boolean;
}

export function useMonths(): MonthOption[] {
  const { meta } = useStory();
  const { rows } = useRows<{ month: number; monthSql: string }>(MONTHS_SQL);
  return useMemo(() => {
    if (!meta) return [];
    return rows.map((r) => {
      const next = new Date(r.month);
      next.setUTCMonth(next.getUTCMonth() + 1);
      const started = r.month < meta.latestRunDate;
      const complete = meta.firstRunDate < r.month && next.getTime() <= meta.latestRunDate;
      const suffix = !started ? ' (booked so far)' : complete ? '' : ' (partial month)';
      return { value: r.monthSql, epochMs: r.month, complete, started, label: monthLabel(r.month) + suffix };
    });
  }, [rows, meta]);
}

/** The months that have started, for revenue and occupancy controls. */
export function useStartedMonths(): MonthOption[] {
  const months = useMonths();
  return useMemo(() => months.filter((m) => m.started), [months]);
}
