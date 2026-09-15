import { SpinnerPane } from '@sqlrooms/ui';
import type { FC, ReactNode } from 'react';
import { useRoomStore } from '../store';

/**
 * Renders children once the database is attached, a spinner while loading,
 * and the error if attaching failed.
 */
export const DataStatusGate: FC<{ children: ReactNode }> = ({ children }) => {
  const status = useRoomStore((s) => s.dataInit.status);
  const error = useRoomStore((s) => s.dataInit.error);

  if (status === 'error') {
    return (
      <div className="flex h-full flex-col gap-2 overflow-auto p-6 text-sm">
        <p className="text-destructive font-medium">
          Could not load the database.
        </p>
        <pre className="text-muted-foreground whitespace-pre-wrap text-xs">
          {error}
        </pre>
        <p className="text-muted-foreground text-xs">
          If this mentions a missing table, <code>data/anchorage_str.duckdb</code>{' '}
          predates the current schema; the next scraper run migrates it.
        </p>
      </div>
    );
  }

  if (status !== 'ready') {
    return <SpinnerPane className="h-full" />;
  }

  return <>{children}</>;
};
