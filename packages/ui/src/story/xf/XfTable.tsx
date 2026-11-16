import { makeQualifiedTableName } from '@sqlrooms/duckdb';
import { DataTableExplorer, useDataTableExplorer } from '@sqlrooms/mosaic';
import { useMemo, type FC, type MouseEvent } from 'react';
import { useXf } from './context';

/**
 * The chapter's listings as a table. Each column header profiles its
 * values; clicking a category or brushing a range there adds a clause to
 * the chapter's selection. Clicking a row opens that listing's details.
 */
export const XfTable: FC<{ columns: readonly string[] }> = ({ columns }) => {
  const { table, version } = useXf();
  // A rebuilt table is a new table to the explorer's clients.
  return <TableInner key={`${table}-${version}`} columns={columns} />;
};

const TableInner: FC<{ columns: readonly string[] }> = ({ columns }) => {
  const { table, selection, setPicked } = useXf();
  const tableName = useMemo(() => makeQualifiedTableName({ table }), [table]);
  // listing_id rides along last so a clicked row can name its listing.
  const shown = useMemo(() => [...columns.filter((c) => c !== 'listing_id'), 'listing_id'], [columns]);
  const explorer = useDataTableExplorer({ tableName, selection, columns: shown, pageSize: 50 });

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    // A data row's first cell is its 1-based number across pages.
    const row = (e.target as HTMLElement).closest('tbody tr');
    const number = Number(row?.querySelector('td')?.textContent);
    if (!number) return;
    const { pageIndex, pageSize } = explorer.pagination;
    const id = explorer.pageTable?.getChild('listing_id')?.get(number - 1 - pageIndex * pageSize);
    if (id != null) setPicked(String(id));
  };

  return (
    <DataTableExplorer.Root explorer={explorer}>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="h-full w-full overflow-auto text-xs [&_tbody_tr]:cursor-pointer" onClick={onClick}>
          <DataTableExplorer.Table>
            <DataTableExplorer.Header />
            <DataTableExplorer.Rows />
          </DataTableExplorer.Table>
        </div>
      </div>
      <DataTableExplorer.StatusBar />
    </DataTableExplorer.Root>
  );
};
