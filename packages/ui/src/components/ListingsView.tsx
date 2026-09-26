import {airbnbListingObservations} from '@anchorage-str-db/db/schema';
import {toSql} from '@anchorage-str-db/db/sql';
import {
  listingPhotosCurrent,
  listingsActiveWithHost as withHost,
  listingsActiveWithRegistration as withRegistration,
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
import {and, desc, eq, ilike, or, sql, type SQL} from 'drizzle-orm';
import {QueryBuilder} from 'drizzle-orm/pg-core';
import {useMemo, useState, type FC} from 'react';
import {
  REGISTRATION_STATUSES,
  registrationStatusSql,
  type RegistrationStatus,
} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

const PAGE_SIZE = 50;

type TableProps = DataTablePaginatedProps<object>;
type PaginationState = NonNullable<TableProps['pagination']>;
type SortingState = NonNullable<TableProps['sorting']>;

/** Builds queries without a connection; `toSql` renders them for SQLRooms. */
const qb = new QueryBuilder();

/** Each listing's latest observation: the row of it with the newest scrape. */
const latest = qb
  .selectDistinctOn([airbnbListingObservations.listingId], {
    listingId: airbnbListingObservations.listingId,
    ratingValue: airbnbListingObservations.ratingValue,
    reviewCount: airbnbListingObservations.reviewCount,
    quoteTotal: airbnbListingObservations.quoteTotal,
    quoteNights: airbnbListingObservations.quoteNights,
    quoteCheckIn: airbnbListingObservations.quoteCheckIn,
    priceHintPerNight: airbnbListingObservations.priceHintPerNight,
  })
  .from(airbnbListingObservations)
  .orderBy(
    airbnbListingObservations.listingId,
    desc(airbnbListingObservations.scrapeDate),
  )
  .as('o');

/**
 * Photos come from `listing_photos_current`, not `listings`: they are stored
 * outside the listing versions, so the current set is the latest one written.
 * `photo_urls[1]` is the cover photo (DuckDB lists are 1-based).
 *
 * The registration columns come from the Muni registration matching the
 * number the listing page shows; see `listings_active_with_registration`.
 */
const LISTING_FIELDS = {
  photo: sql<string>`${listingPhotosCurrent.photoUrls}[1]`.as('photo'),
  listing_id: withHost.listingId,
  name: withHost.name,
  property_title: withHost.propertyTitle,
  listing_type: withHost.listingType,
  bedrooms: withHost.bedrooms,
  beds: withHost.beds,
  bathrooms: withHost.bathrooms,
  guest_capacity: withHost.guestCapacity,
  rating_value: latest.ratingValue,
  review_count: latest.reviewCount,
  quote_total: latest.quoteTotal,
  quote_nights: latest.quoteNights,
  quote_check_in: latest.quoteCheckIn,
  price_hint_per_night: latest.priceHintPerNight,
  host_name: withHost.hostName,
  host_years_hosting: withHost.hostYearsHosting,
  host_listings_active: withHost.hostListingsActive,
  host_listings_ever_seen: withHost.hostListingsEverSeen,
  registration_status: registrationStatusSql(withRegistration).as('registration_status'),
  registration_id: withHost.registrationId,
  registration_address: withRegistration.registrationAddress,
  registration_parcel_id: withRegistration.registrationParcelId,
  registration_parcel_type: withRegistration.registrationParcelType,
  registration_community_council: withRegistration.registrationCommunityCouncil,
  registration_business_name: withRegistration.registrationBusinessName,
  registration_expires_date: withRegistration.registrationExpiresDate,
  first_available_date_est: withHost.firstAvailableDateEst,
  first_review_date: withHost.firstReviewDate,
  first_seen_date: withHost.firstSeenDate,
  last_seen_date: withHost.lastSeenDate,
  url: withHost.url,
};

/** The table, before the search box's and the status toggle's filters. */
const listingsQuery = (where: SQL | undefined) =>
  qb
    .select(LISTING_FIELDS)
    .from(withHost)
    .innerJoin(withRegistration, eq(withRegistration.listingId, withHost.listingId))
    .leftJoin(
      listingPhotosCurrent,
      eq(listingPhotosCurrent.listingId, withHost.listingId),
    )
    .leftJoin(latest, eq(latest.listingId, withHost.listingId))
    .where(where)
    .orderBy(desc(withHost.lastSeenDate));

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
  const [status, setStatus] = useState<RegistrationStatus | typeof ALL_STATUSES>(
    ALL_STATUSES,
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const query = useMemo(() => {
    const term = search.trim();
    const pattern = `%${term}%`;
    return toSql(
      listingsQuery(
        and(
          term
            ? or(
                ilike(withHost.name, pattern),
                ilike(withHost.propertyTitle, pattern),
                ilike(withHost.hostName, pattern),
                ilike(withHost.registrationId, pattern),
                ilike(withRegistration.registrationAddress, pattern),
              )
            : undefined,
          status === ALL_STATUSES
            ? undefined
            : eq(registrationStatusSql(withRegistration), status),
        ),
      ),
    );
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
