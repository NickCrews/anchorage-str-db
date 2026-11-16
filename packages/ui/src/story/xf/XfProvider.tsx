import { isWasmDuckDbConnector } from '@sqlrooms/duckdb';
import { Selection } from '@sqlrooms/mosaic';
import { SpinnerPane } from '@sqlrooms/ui';
import { useCallback, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';
import { useRoomStore } from '../../store';
import { useStory } from '../context';
import { useChapterNear } from '../near';
import { XfContext, useXfMaybe, type XfContextValue } from './context';
import { buildXfTableSql, xfTableName } from './table';

/** The selection's predicate as one SQL condition, `true` when it has no clauses. */
function predicateSql(selection: XfContextValue['selection']): string {
  const raw = selection.predicate(null as never) as unknown;
  const parts = ([] as unknown[])
    .concat(raw ?? [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  return parts.length ? parts.map((p) => `(${p})`).join(' AND ') : 'true';
}

/**
 * Builds a chapter's cross-filter table for `month` and provides its Mosaic
 * selection to everything in the chapter: the chart in the narrative
 * column, and the map and table in the panel. Children render before the
 * table is ready; parts that need it wait inside `XfReady`.
 */
export const XfProvider: FC<{ chapterId: string; month: string; children: ReactNode }> = ({ chapterId, month, children }) => {
  const dataReady = useRoomStore((s) => s.dataInit.status) === 'ready';
  const mosaicReady = useRoomStore((s) => s.mosaic.connection.status) === 'ready';
  const getConnector = useRoomStore((s) => s.db.getConnector);
  const refreshTableSchemas = useRoomStore((s) => s.db.refreshTableSchemas);
  // The chapter's own selection, outside the store: creating one there
  // during render would update the store mid-render.
  const selection = useMemo(() => Selection.crossfilter(), []);
  const near = useChapterNear();
  const { model } = useStory();
  const table = xfTableName(chapterId, model, month);
  const built = table;

  const [builtMonth, setBuiltMonth] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<Error | null>(null);
  useEffect(() => {
    if (!dataReady || !month || !near) return;
    let cancelled = false;
    (async () => {
      try {
        const connector = await getConnector();
        if (!isWasmDuckDbConnector(connector)) throw new Error('Expected the WASM DuckDB connector.');
        await connector.execute(buildXfTableSql(table, month, model)).result;
        await refreshTableSchemas();
        if (!cancelled) {
          selection.reset();
          setBuiltMonth(built);
        }
      } catch (err) {
        if (!cancelled) setBuildError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataReady, month, model, built, near, table, getConnector, refreshTableSchemas, selection]);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onValue = () => setVersion((v) => v + 1);
    selection.addEventListener('value', onValue);
    return () => selection.removeEventListener('value', onValue);
  }, [selection]);

  const [picked, setPicked] = useState<string | null>(null);
  const clear = useCallback(() => selection.reset(), [selection]);
  const ready = mosaicReady && builtMonth === built;
  const value = useMemo<XfContextValue | null>(
    () =>
      ready
        ? { table, month, version: built, selection, predicate: predicateSql(selection), filters: selection.clauses.length, clear, picked, setPicked }
        : null,
    // `version` stands in for the selection's changing clauses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, table, month, built, selection, version, clear, picked],
  );

  if (buildError) {
    return <pre className="text-destructive p-4 text-xs whitespace-pre-wrap">{buildError.message}</pre>;
  }
  return <XfContext.Provider value={value}>{children}</XfContext.Provider>;
};

/** Renders children once the chapter's table is built, a spinner before. */
export const XfReady: FC<{ children: ReactNode; className?: string }> = ({ children, className }) =>
  useXfMaybe() ? <>{children}</> : <SpinnerPane className={className ?? 'h-full'} />;

/** "N filters · clear", shown while the chapter's selection has clauses. */
export const XfFilterChip: FC = () => {
  const xf = useXfMaybe();
  if (!xf || xf.filters === 0) return null;
  return (
    <button onClick={xf.clear} className="hover:bg-muted rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap">
      {xf.filters} filter{xf.filters > 1 ? 's' : ''} · clear
    </button>
  );
};
