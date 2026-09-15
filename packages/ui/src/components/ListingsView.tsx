import {airbnbListingObservations} from '@anchorage-str-db/db/schema';
import {from, toSql} from '@anchorage-str-db/db/sql';
import {
  listingPhotosCurrent,
  listingsCurrentWithHost,
  listingsCurrentWithRegistration,
} from '@anchorage-str-db/db/viewSchema';
import {
  DataTablePaginated,
  type DataTablePaginatedProps,
  makePagedQuery,
  QueryDataTableActionsMenu,
  useArrowDataTable,
} from '@sqlrooms/data-table';
import {sanitizeQuery, useSql} from '@sqlrooms/duckdb';
import {Badge, Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {sql, type SQL} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import {useMemo, useState, type FC} from 'react';
import {REGISTRATION_STATUSES, registrationStatusSql} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

const PAGE_SIZE = 50;

type TableProps = DataTablePaginatedProps<object>;
type PaginationState = NonNullable<TableProps['pagination']>;
type SortingState = NonNullable<TableProps['sorting']>;

const l = alias(listingsCurrentWithHost, 'l');
const r = alias(listingsCurrentWithRegistration, 'r');
const p = alias(listingPhotosCurrent, 'p');
/** Each listing's latest observation: one row of the table it comes from. */
const o = alias(airbnbListingObservations, 'o');

/**
 * Photos come from `listing_photos_current`, not `listings`: they are stored
 * outside the listing versions, so the current set is the latest one written.
 * `photo_urls[1]` is the cover photo (DuckDB lists are 1-based).
 *
 * The registration columns come from the Muni registration matching the
 * number the listing page shows; see `listings_current_with_registration`.
 */
const BASE_QUERY = sql`
  SELECT
    ${p.photoUrls}[1] AS photo,
    ${l.listingId},
    ${l.name},
    ${l.propertyTitle},
    ${l.roomType},
    ${l.bedrooms},
    ${l.beds},
    ${l.bathrooms},
    ${l.guestCapacity},
    ${o.ratingValue},
    ${o.reviewCount},
    ${o.quoteTotal},
    ${o.quoteNights},
    ${o.quoteCheckIn},
    ${o.priceHintPerNight},
    ${l.hostName},
    ${l.hostYearsHosting},
    ${l.hostListingsLive},
    ${l.hostListingsEverSeen},
    ${registrationStatusSql(r)} AS registration_status,
    ${l.strRegistrationId},
    ${r.registrationLocation},
    ${r.registrationParcelId},
    ${r.registrationParcelType},
    ${r.registrationCommunityCouncil},
    ${r.registrationBusinessName},
    ${r.registrationExpiresDate},
    ${l.firstAvailableDateEst},
    ${l.firstReviewDate},
    ${l.firstSeenDate},
    ${l.lastSeenDate},
    ${l.url}
  FROM ${from(listingsCurrentWithHost, l)}
  JOIN ${from(listingsCurrentWithRegistration, r)} USING (listing_id)
  LEFT JOIN ${from(listingPhotosCurrent, p)} ON ${p.listingId} = ${l.listingId}
  LEFT JOIN (
    SELECT *
    FROM ${from(airbnbListingObservations)}
    QUALIFY row_number() OVER (
      PARTITION BY ${airbnbListingObservations.listingId}
      ORDER BY ${airbnbListingObservations.scrapeDate} DESC
    ) = 1
  ) ${o} ON ${o.listingId} = ${l.listingId}
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
    const filters: SQL[] = [];
    const term = search.trim();
    if (term) {
      const pattern = `%${term}%`;
      filters.push(
        sql`(${l.name} ILIKE ${pattern} OR ${l.propertyTitle} ILIKE ${pattern}
          OR ${l.hostName} ILIKE ${pattern} OR ${l.strRegistrationId} ILIKE ${pattern}
          OR ${r.registrationLocation} ILIKE ${pattern})`,
      );
    }
    if (status !== ALL_STATUSES) {
      filters.push(sql`${registrationStatusSql(r)} = ${status}`);
    }
    const where = sql.join(filters.map((filter) => sql`\n  AND ${filter}`));
    return toSql(sql`${BASE_QUERY}${where}\n  ORDER BY ${l.lastSeenDate} DESC`);
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
          placeholder="Filter by listing, host, registration number or address…"
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
