import {toSql} from '@anchorage-str-db/db/sql';
import {
  listingsActiveWithHost as withHost,
  listingsActiveWithRegistration as withRegistration,
} from '@anchorage-str-db/db/viewSchema';
import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {and, asc, desc, eq, gt, gte, ilike, sql, type SQL} from 'drizzle-orm';
import {QueryBuilder} from 'drizzle-orm/pg-core';
import {useMemo, useState, type FC} from 'react';
import {
  registrationStatusSql,
  type RegistrationStatus,
} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

/** Builds queries without a connection; `toSql` renders them for SQLRooms. */
const qb = new QueryBuilder();

/** How each listing's registration id matched, to count up per host. */
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
 * One row per host with active listings. `business_names` are the names on
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
  listings_active: sql<number>`count(*)::INT`.as('listings_active'),
  host_listings_ever_seen: sql<
    number | null
  >`any_value(${withHost.hostListingsEverSeen})`.as('host_listings_ever_seen'),
  registration_ids: sql<number>`count(DISTINCT ${withHost.registrationId})::INT`.as(
    'registration_ids',
  ),
  listings_registered: listingsWith('Registered').as('listings_registered'),
  listings_registration_lapsed: listingsWith('Registration lapsed').as(
    'listings_registration_lapsed',
  ),
  listings_id_not_in_registry: listingsWith('Id not in registry').as(
    'listings_id_not_in_registry',
  ),
  listings_no_id_shown: listingsWith('No id shown').as(
    'listings_no_id_shown',
  ),
  business_names: sql<
    string | null
  >`string_agg(DISTINCT trim(${matches.businessName}), '; ')`.as('business_names'),
  host_url: sql<string>`'https://www.airbnb.com/users/show/' || ${withHost.hostId}`.as(
    'host_url',
  ),
  search_text: sql<string>`concat_ws(' ', ${withHost.hostName},
    string_agg(DISTINCT ${matches.businessName}, ' '),
    string_agg(DISTINCT ${withHost.registrationId}, ' '))`.as('search_text'),
};

/**
 * One row per host, read back as a subquery so the filters and the ordering
 * below are checked against the columns it counts up rather than naming them
 * as text.
 */
const hosts = qb
  .select(HOST_FIELDS)
  .from(withHost)
  .innerJoin(matches, eq(matches.listingId, withHost.listingId))
  .groupBy(withHost.hostId, withHost.hostName)
  .as('hosts');

/** The table, before the search box's and the scope toggle's filters. */
const hostsQuery = (where: SQL | undefined) =>
  qb
    // `search_text` is for filtering only; DuckDB's `EXCLUDE` drops it without
    // naming every other column again.
    .select({all: sql`* EXCLUDE (search_text)`})
    .from(hosts)
    .where(where)
    .orderBy(desc(hosts.listings_active), asc(hosts.host_name));

const SCOPES = {
  all: 'All',
  multi: '2+ listings',
  noId: 'Some listings show no id',
} as const;
type Scope = keyof typeof SCOPES;

const SCOPE_FILTER: Record<Scope, SQL | undefined> = {
  all: undefined,
  multi: gte(hosts.listings_active, 2),
  noId: gt(hosts.listings_no_id_shown, 0),
};

export const HostsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');

  const query = useMemo(() => {
    const term = search.trim();
    return toSql(
      hostsQuery(
        and(
          SCOPE_FILTER[scope],
          term ? ilike(hosts.search_text, `%${term}%`) : undefined,
        ),
      ),
    );
  }, [search, scope]);

  return (
    <DataStatusGate>
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Filter by host, business name or registration id…"
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
          are the registrants on the registrations the host's listings show,
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
