import {toSql} from '@anchorage-str-db/db/sql';
import {
  listingsCurrentWithHost as withHost,
  listingsCurrentWithRegistration as withRegistration,
} from '@anchorage-str-db/db/viewSchema';
import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {and, eq, sql, type SQL} from 'drizzle-orm';
import {QueryBuilder} from 'drizzle-orm/pg-core';
import {useMemo, useState, type FC} from 'react';
import {
  registrationStatusSql,
  type RegistrationStatus,
} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

/** Builds queries without a connection; `toSql` renders them for SQLRooms. */
const qb = new QueryBuilder();

/** How each listing's registration number matched, to count up per host. */
const matches = qb
  .select({
    listingId: withRegistration.listingId,
    status: registrationStatusSql(withRegistration).as('status'),
    businessName: withRegistration.registrationBusinessName,
  })
  .from(withRegistration)
  .as('r');

const listingsWith = (status: RegistrationStatus) =>
  sql<number>`count(*) FILTER (WHERE ${matches.status} = ${status})::INT`;

/**
 * One row per host with current listings. `business_names` are the names on
 * the registrations the host's listings cite; a property manager's listings
 * cite many owners' registrations, so a host is not an owner (see
 * docs/data_model.md). `search_text` exists only for filtering.
 */
const HOST_FIELDS = {
  host_name: withHost.hostName,
  host_id: withHost.hostId,
  host_years_hosting: sql<number | null>`any_value(${withHost.hostYearsHosting})`.as(
    'host_years_hosting',
  ),
  listings_current: sql<number>`count(*)::INT`.as('listings_current'),
  host_listings_ever_seen: sql<
    number | null
  >`any_value(${withHost.hostListingsEverSeen})`.as('host_listings_ever_seen'),
  registration_numbers: sql<number>`count(DISTINCT ${withHost.strRegistrationId})::INT`.as(
    'registration_numbers',
  ),
  listings_registered: listingsWith('Registered').as('listings_registered'),
  listings_registration_not_current: listingsWith('Registration not current').as(
    'listings_registration_not_current',
  ),
  listings_number_not_in_registry: listingsWith('Number not in registry').as(
    'listings_number_not_in_registry',
  ),
  listings_no_number_shown: listingsWith('No number shown').as(
    'listings_no_number_shown',
  ),
  business_names: sql<
    string | null
  >`string_agg(DISTINCT trim(${matches.businessName}), '; ')`.as('business_names'),
  host_url: sql<string>`'https://www.airbnb.com/users/show/' || ${withHost.hostId}`.as(
    'host_url',
  ),
  search_text: sql<string>`concat_ws(' ', ${withHost.hostName},
    string_agg(DISTINCT ${matches.businessName}, ' '),
    string_agg(DISTINCT ${withHost.strRegistrationId}, ' '))`.as('search_text'),
};

const HOSTS_QUERY = qb
  .select(HOST_FIELDS)
  .from(withHost)
  .innerJoin(matches, eq(matches.listingId, withHost.listingId))
  .groupBy(withHost.hostId, withHost.hostName);

const SCOPES = {
  all: 'All',
  multi: '2+ listings',
  noNumber: 'Some listings show no number',
} as const;
type Scope = keyof typeof SCOPES;

// The columns `HOSTS_QUERY` counts up, so these are its names, not a view's.
const SCOPE_FILTER: Record<Scope, SQL | undefined> = {
  all: undefined,
  multi: sql`listings_current >= 2`,
  noNumber: sql`listings_no_number_shown > 0`,
};

export const HostsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');

  const query = useMemo(() => {
    const term = search.trim();
    // `search_text` and the counts are the subquery's own columns, so the
    // filters below are SQL text rather than schema columns.
    const where = and(
      SCOPE_FILTER[scope],
      term ? sql`search_text ILIKE ${`%${term}%`}` : undefined,
    );
    return toSql(sql`SELECT * EXCLUDE (search_text)
FROM ${HOSTS_QUERY}
${where ? sql`WHERE ${where}` : sql.empty()}
ORDER BY listings_current DESC, host_name`);
  }, [search, scope]);

  return (
    <DataStatusGate>
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Filter by host, business name or registration number…"
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
        <p className="text-muted-foreground max-w-4xl text-xs">
          Each row is an Airbnb host account with at least one active listing.
          A host is whoever runs the listing on Airbnb, often a property
          management company, and not necessarily the owner. "Business names"
          are the names on the city registrations the host's listings show,
          which is the closest thing to the owners this data has.
        </p>
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
