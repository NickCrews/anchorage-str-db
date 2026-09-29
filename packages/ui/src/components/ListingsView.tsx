import {toSql} from '@anchorage-str-db/db/sql';
import {
  DataTablePaginated,
  type DataTablePaginatedProps,
  makePagedQuery,
  QueryDataTableActionsMenu,
  useArrowDataTable,
} from '@sqlrooms/data-table';
import {sanitizeQuery, useSql} from '@sqlrooms/duckdb';
import {Badge, Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {ALL_STATUSES, listingsTableQuery} from '../queries/listings';
import {REGISTRATION_STATUSES, type RegistrationStatus} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

const PAGE_SIZE = 50;

type TableProps = DataTablePaginatedProps<object>;
type PaginationState = NonNullable<TableProps['pagination']>;
type SortingState = NonNullable<TableProps['sorting']>;

/** Airbnb's CDN resizes on request: `im_w=240` is ~6 KB against ~190 KB for the original. */
const thumbnailUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}im_w=240`;

const Thumbnail: FC<{url: unknown}> = ({url}) =>
  typeof url === 'string' ? (
    <img
      src={thumbnailUrl(url)}
      alt=""
      loading="lazy"
      className="h-12 w-16 max-w-none rounded object-cover"
      // A URL dies when the host removes that photo; hide it rather than show a broken image.
      onError={(e) => {
        e.currentTarget.hidden = true;
      }}
    />
  ) : null;

export const ListingsView: FC = () => {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<RegistrationStatus | typeof ALL_STATUSES>(
    ALL_STATUSES,
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const query = useMemo(() => toSql(listingsTableQuery(search, status)), [search, status]);

  // QueryDataTable renders every cell as text, so this assembles the same
  // pieces with an image cell for the photo column.
  const sanitized = useMemo(() => sanitizeQuery(query), [query]);
  const page = useSql({query: makePagedQuery(sanitized, sorting, pagination)});
  const count = useSql<{count: number}>({query: `SELECT COUNT(*)::int AS count FROM (${sanitized})`});
  const table = useArrowDataTable(page.data?.arrowTable, {fontSize: 'text-xs'});

  const columns = useMemo(
    () =>
      table?.columns.map((column, i) =>
        i === 0
          ? {
              ...column,
              // tanstack derives a column's id from a string header, so a blank
              // header needs an explicit one.
              id: 'photo',
              header: '',
              enableSorting: false,
              cell: (info: {getValue: () => unknown}) => <Thumbnail url={info.getValue()} />,
            }
          : column,
      ),
    [table],
  );

  return (
    <DataStatusGate>
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter by listing, host, registration id or address…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPagination((p) => ({...p, pageIndex: 0}));
          }}
          className="max-w-sm"
        />
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={status}
          onValueChange={(v) => {
            if (!v) return;
            setStatus(v as RegistrationStatus | typeof ALL_STATUSES);
            setPagination((p) => ({...p, pageIndex: 0}));
          }}
        >
          {[ALL_STATUSES, ...REGISTRATION_STATUSES].map((s) => (
            <ToggleGroupItem key={s} value={s} className="px-2 text-xs">
              {s}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Badge variant="secondary">currently active listings</Badge>
      </div>
      <div className="min-h-0 flex-1">
        {page.error ? (
          <pre className="p-5 text-xs text-red-500">{page.error.message}</pre>
        ) : (
          <DataTablePaginated
            data={table?.data}
            columns={columns}
            fontSize="text-xs"
            numRows={count.data?.toArray()[0]?.count}
            isFetching={page.isLoading}
            pagination={pagination}
            onPaginationChange={setPagination}
            sorting={sorting}
            onSortingChange={setSorting}
            footerActions={<QueryDataTableActionsMenu query={sanitized} />}
          />
        )}
      </div>
    </div>
    </DataStatusGate>
  );
};
