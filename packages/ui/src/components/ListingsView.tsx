import {
  DataTablePaginated,
  type DataTablePaginatedProps,
  makePagedQuery,
  QueryDataTableActionsMenu,
  useArrowDataTable,
} from '@sqlrooms/data-table';
import {escapeVal, sanitizeQuery, useSql} from '@sqlrooms/duckdb';
import {Badge, Input} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {DataStatusGate} from './DataStatusGate';

const PAGE_SIZE = 50;

type TableProps = DataTablePaginatedProps<object>;
type PaginationState = NonNullable<TableProps['pagination']>;
type SortingState = NonNullable<TableProps['sorting']>;

/**
 * Photos come from `listing_photos_current`, not `listings`: they are stored
 * outside the listing versions, so the current set is the latest one written.
 * `photo_urls[1]` is the cover photo (DuckDB lists are 1-based).
 */
const BASE_QUERY = `
  SELECT
    p.photo_urls[1] AS photo,
    l.listing_id,
    l.name,
    l.property_title,
    l.room_type,
    l.bedrooms,
    l.beds,
    l.bathrooms,
    l.guest_capacity,
    o.rating_value,
    o.review_count,
    o.quote_total,
    o.quote_nights,
    o.quote_check_in,
    o.price_hint_per_night,
    l.first_seen_date,
    l.last_seen_date,
    l.url
  FROM listings l
  LEFT JOIN listing_photos_current p ON p.listing_id = l.listing_id
  LEFT JOIN (
    SELECT *
    FROM listing_observations
    QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY scrape_date DESC) = 1
  ) o ON o.listing_id = l.listing_id
  WHERE l.is_current
`;

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
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const query = useMemo(() => {
    const term = search.trim();
    if (!term) return `${BASE_QUERY}\n  ORDER BY l.last_seen_date DESC`;
    const pattern = escapeVal(`%${term}%`);
    return `${BASE_QUERY}\n  AND (l.name ILIKE ${pattern} OR l.property_title ILIKE ${pattern})\n  ORDER BY l.last_seen_date DESC`;
  }, [search]);

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
      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter by name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPagination((p) => ({...p, pageIndex: 0}));
          }}
          className="max-w-xs"
        />
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
