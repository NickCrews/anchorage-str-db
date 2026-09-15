import {from, toSql} from '@anchorage-str-db/db/sql';
import {
  listingsCurrentWithHost,
  listingsCurrentWithRegistration,
} from '@anchorage-str-db/db/viewSchema';
import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {sql, type SQL} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import {useMemo, useState, type FC} from 'react';
import {registrationStatusSql} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

const l = alias(listingsCurrentWithHost, 'l');
/** The same view with a `status` column added; the join below builds it. */
const r = alias(listingsCurrentWithRegistration, 'r');

/**
 * One row per host with current listings. `business_names` are the names on
 * the registrations the host's listings cite; a property manager's listings
 * cite many owners' registrations, so a host is not an owner (see
 * docs/data_model.md). `search_text` exists only for filtering.
 */
const HOSTS_QUERY = sql`
  SELECT
    ${l.hostName},
    ${l.hostId},
    any_value(${l.hostYearsHosting}) AS host_years_hosting,
    count(*)::INT AS listings_current,
    any_value(${l.hostListingsEverSeen}) AS host_listings_ever_seen,
    count(DISTINCT ${l.strRegistrationId})::INT AS registration_numbers,
    count(*) FILTER (WHERE status = 'Registered')::INT AS listings_registered,
    count(*) FILTER (WHERE status = 'Registration not current')::INT
      AS listings_registration_not_current,
    count(*) FILTER (WHERE status = 'Number not in registry')::INT
      AS listings_number_not_in_registry,
    count(*) FILTER (WHERE status = 'No number shown')::INT AS listings_no_number_shown,
    string_agg(DISTINCT trim(${r.registrationBusinessName}), '; ') AS business_names,
    'https://www.airbnb.com/users/show/' || ${l.hostId} AS host_url,
    concat_ws(' ', ${l.hostName}, string_agg(DISTINCT ${r.registrationBusinessName}, ' '),
      string_agg(DISTINCT ${l.strRegistrationId}, ' ')) AS search_text
  FROM ${from(listingsCurrentWithHost, l)}
  JOIN (
    SELECT *, ${registrationStatusSql(listingsCurrentWithRegistration)} AS status
    FROM ${from(listingsCurrentWithRegistration)}
  ) ${r} USING (listing_id)
  GROUP BY ${l.hostId}, ${l.hostName}
`;

const SCOPES = {
  all: 'All',
  multi: '2+ listings',
  noNumber: 'Some listings show no number',
} as const;
type Scope = keyof typeof SCOPES;

// The columns `HOSTS_QUERY` counts up, so these are its names, not a view's.
const SCOPE_FILTER: Record<Scope, SQL | null> = {
  all: null,
  multi: sql`listings_current >= 2`,
  noNumber: sql`listings_no_number_shown > 0`,
};

export const HostsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');

  const query = useMemo(() => {
    const filters: SQL[] = [];
    const scopeFilter = SCOPE_FILTER[scope];
    if (scopeFilter) filters.push(scopeFilter);
    const term = search.trim();
    if (term) filters.push(sql`search_text ILIKE ${`%${term}%`}`);
    const where = sql.join(filters.map((filter) => sql`\n  AND ${filter}`));
    return toSql(sql`SELECT * EXCLUDE (search_text)
FROM (${HOSTS_QUERY})
WHERE true${where}
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
