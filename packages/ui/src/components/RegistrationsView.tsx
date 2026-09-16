import {toSql} from '@anchorage-str-db/db/sql';
import {registrations} from '@anchorage-str-db/db/viewSchema';
import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {and, asc, eq, ilike, or, sql, type SQL} from 'drizzle-orm';
import {QueryBuilder} from 'drizzle-orm/pg-core';
import {useMemo, useState, type FC} from 'react';
import {DataStatusGate} from './DataStatusGate';

/** Builds queries without a connection; `toSql` renders them for SQLRooms. */
const qb = new QueryBuilder();

/**
 * `license_*` columns come from the latest CityView license page read, which
 * is re-read about weekly, so they can be NULL for a new registration.
 * `airbnb_listings_current` counts current Airbnb listings showing the number.
 */
const REGISTRATION_FIELDS = {
  registration_number: registrations.registrationNumber,
  business_name: registrations.businessName,
  location: registrations.location,
  community_council: registrations.communityCouncil,
  parcel_type: registrations.parcelType,
  parcel_id: registrations.parcelId,
  airbnb_listings_current: registrations.airbnbListingsCurrent,
  issued_date: registrations.issuedDate,
  expires_date: registrations.expiresDate,
  status: registrations.status,
  license_status: registrations.licenseStatus,
  license_description: registrations.licenseDescription,
  license_read_date: registrations.licenseReadDate,
  first_seen_date: registrations.firstSeenDate,
  last_seen_date: registrations.lastSeenDate,
  is_current: registrations.isCurrent,
  status_url: registrations.statusUrl,
};

/** The table, before the search box's and the scope toggle's filters. */
const registrationsQuery = (where: SQL | undefined) =>
  qb
    .select(REGISTRATION_FIELDS)
    .from(registrations)
    .where(where)
    .orderBy(
      sql`${registrations.issuedDate} DESC NULLS LAST`,
      asc(registrations.registrationNumber),
    );

const SCOPES = {
  current: 'Current',
  unlisted: 'Current, no Airbnb listing',
  lapsed: 'No longer published',
  all: 'All',
} as const;
type Scope = keyof typeof SCOPES;

const SCOPE_FILTER: Record<Scope, SQL | undefined> = {
  current: eq(registrations.isCurrent, true),
  unlisted: and(
    eq(registrations.isCurrent, true),
    eq(registrations.airbnbListingsCurrent, 0),
  ),
  lapsed: eq(registrations.isCurrent, false),
  all: undefined,
};

export const RegistrationsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('current');

  const query = useMemo(() => {
    const term = search.trim();
    const pattern = `%${term}%`;
    return toSql(
      registrationsQuery(
        and(
          SCOPE_FILTER[scope],
          term
            ? or(
                ilike(registrations.registrationNumber, pattern),
                ilike(registrations.businessName, pattern),
                ilike(registrations.location, pattern),
                ilike(registrations.communityCouncil, pattern),
                ilike(registrations.parcelId, pattern),
                ilike(registrations.licenseDescription, pattern),
              )
            : undefined,
        ),
      ),
    );
  }, [search, scope]);

  return (
    <DataStatusGate>
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Filter by number, business, address, council, parcel or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={scope}
            onValueChange={(v) => v && setScope(v as Scope)}
          >
            {(Object.keys(SCOPES) as Scope[]).map((key) => (
              <ToggleGroupItem key={key} value={key} className="px-2 text-xs">
                {SCOPES[key]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="text-muted-foreground max-w-4xl space-y-1 text-xs">
          <p>
            Each row is a short-term rental registration from the Municipality
            of Anchorage. Operators register a rental with the city and get a
            number like STR20261754, which they are expected to show on their
            listing. The city publishes only active registrations, so one that
            is no longer published has lapsed or been withdrawn.
          </p>
          <p>
            A <strong>listing</strong> is an Airbnb page. A{' '}
            <strong>host</strong> is the Airbnb account running it, often a
            property manager. The only thing tying a listing to a
            registration is the number on the listing page. Most registrations
            are shown by one listing. Some are shown by several, such as
            separate rooms in one house. Some are shown by none: the rental
            may be on another site, not operating, or listed without its
            number.
          </p>
        </div>
        <div className="min-h-0 flex-1">
          <QueryDataTable
            query={query}
            fontSize="text-xs"
            pageSize={50}
            renderActions={(q) => <QueryDataTableActionsMenu query={q} />}
          />
        </div>
      </div>
    </DataStatusGate>
  );
};
