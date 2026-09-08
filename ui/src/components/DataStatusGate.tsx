import { SpinnerPane } from '@sqlrooms/ui';
import type { FC, ReactNode } from 'react';
import { useRoomStore } from '../store';

/**
 * Renders children only once the database is attached, and — importantly —
 * shows the failure when it isn't.
 *
 * Every view used to spin forever on `status !== 'ready'`. The only thing
 * that ever displayed `dataInit.error` was `DataPanel`, which stopped being
 * mounted when the sidebar was removed, so an attach failure (a stale
 * snapshot missing a view, a 404 on the .duckdb file) looked exactly like a
 * slow load: an infinite spinner with no message anywhere.
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
          If this mentions a missing table, the snapshot in{' '}
          <code>ui/public/</code> predates the current schema — re-copy it
          from <code>data/anchorage_str.duckdb</code>.
        </p>
      </div>
    );
  }

  if (status !== 'ready') {
    return <SpinnerPane className="h-full" />;
  }

  return <>{children}</>;
};
