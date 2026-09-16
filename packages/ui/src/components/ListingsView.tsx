import {
  DataTablePaginated,
  type DataTablePaginatedProps,
  makePagedQuery,
  QueryDataTableActionsMenu,
  useArrowDataTable,
} from '@sqlrooms/data-table';
import {escapeVal, sanitizeQuery, useSql} from '@sqlrooms/duckdb';
import {Badge, Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {REGISTRATION_STATUSES, registrationStatusSql} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

const PAGE_SIZE = 50;

type TableProps = DataTablePaginatedProps<object>;
type PaginationState = NonNullable<TableProps['pagination']>;
type SortingState = NonNullable<TableProps['sorting']>;

/**
 * Photos come from `listing_photos_current`, not `listings`: they are stored
 * outside the listing versions, so the current set is the latest one written.
 * `photo_urls[1]` is the cover photo (DuckDB lists are 1-based).
 *
 * The registration columns come from the Muni registration matching the
 * number the listing page shows; see `listings_active_with_registration`.
 */
const BASE_QUERY = `
  SELECT
    p.photo_urls[1] AS photo,
    l.listing_id,
    l.name,
    l.property_title,
    l.listing_type,
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
    l.host_name,
    l.host_years_hosting,
    l.host_listings_active,
    l.host_listings_ever_seen,
    ${registrationStatusSql('r')} AS registration_status,
    l.registration_id,
    r.registration_address,
    r.registration_parcel_id,
    r.registration_parcel_type,
    r.registration_community_council,
    r.registration_business_name,
    r.registration_expires_date,
    l.first_available_date_est,
    l.first_review_date,
    l.first_seen_date,
    l.last_seen_date,
    l.url
  FROM listings_active_with_host l
  JOIN listings_active_with_registration r USING (listing_id)
  LEFT JOIN listing_photos_current p ON p.listing_id = l.listing_id
  LEFT JOIN (
    SELECT *
    FROM airbnb_listing_observations
    QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY scrape_date DESC) = 1
  ) o ON o.listing_id = l.listing_id
  WHERE true
`;

const ALL_STATUSES = 'All';

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
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const query = useMemo(() => {
    const filters: string[] = [];
    const term = search.trim();
    if (term) {
      const pattern = escapeVal(`%${term}%`);
      filters.push(
        `(l.name ILIKE ${pattern} OR l.property_title ILIKE ${pattern} OR l.host_name ILIKE ${pattern}` +
          ` OR l.registration_id ILIKE ${pattern} OR r.registration_address ILIKE ${pattern})`,
      );
    }
    if (status !== ALL_STATUSES) {
      filters.push(`${registrationStatusSql('r')} = ${escapeVal(status)}`);
    }
    const where = filters.map((f) => `\n  AND ${f}`).join('');
    return `${BASE_QUERY}${where}\n  ORDER BY l.last_seen_date DESC`;
  }, [search, status]);

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
            setStatus(v);
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
