import { createContext, useContext, useMemo, useState, type FC, type ReactNode } from 'react';
import { isoDate } from '../format';
import { useRow } from '../lib/query';
import type { Model } from './model';

export interface Meta {
  firstRunDate: number;
  latestRunDate: number;
  /** The latest month whose every night is before the latest run: the month the story quotes. */
  focusMonth: number;
  /** `focusMonth` as `YYYY-MM-DD`, for SQL. */
  focusMonthSql: string;
}

interface StoryContextValue {
  meta: Meta | undefined;
  /** How closed nights are counted, chosen in the Methodology menu. */
  model: Model;
  setModel: (m: Model) => void;
}

const StoryContext = createContext<StoryContextValue | null>(null);

export const StoryProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [model, setModel] = useState<Model>('middle');
  const { row } = useRow<{ firstRunDate: number; latestRunDate: number; focusMonth: number }>(`
    SELECT
      first_run_date AS "firstRunDate",
      latest_run_date AS "latestRunDate",
      -- The month before the latest run's month is the latest one complete,
      -- unless collection started inside it.
      greatest(
        CAST(date_trunc('month', latest_run_date) - INTERVAL 1 MONTH AS DATE),
        CAST(date_trunc('month', first_run_date) AS DATE)
      ) AS "focusMonth"
    FROM est_run_dates
  `);
  const meta = useMemo<Meta | undefined>(
    () => (row ? { ...row, focusMonthSql: isoDate(row.focusMonth) } : undefined),
    [row],
  );
  const value = useMemo(() => ({ meta, model, setModel }), [meta, model]);
  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
};

export function useStory() {
  const value = useContext(StoryContext);
  if (!value) throw new Error('useStory outside StoryProvider');
  return value;
}
