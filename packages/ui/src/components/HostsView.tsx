import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {escapeVal} from '@sqlrooms/duckdb';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {registrationStatusSql} from '../registrationStatus';
import {DataStatusGate} from './DataStatusGate';

/**
 * One row per host with active listings. `business_names` are the names on
 * the registrations the host's listings cite; a property manager's listings
 * cite many owners' registrations, so a host is not an owner (see
 * docs/data_model.md). `search_text` exists only for filtering.
 */
const HOSTS_QUERY = `
  SELECT
    l.host_name,
    l.host_id,
    any_value(l.host_years_hosting) AS host_years_hosting,
    any_value(l.host_listings) AS listings,
    count(*)::INT AS listings_in_muni,
    count(DISTINCT l.registration_id)::INT AS registration_ids,
    count(*) FILTER (WHERE status = 'Registered')::INT AS listings_registered,
    count(*) FILTER (WHERE status = 'Registration lapsed')::INT AS listings_registration_lapsed,
    count(*) FILTER (WHERE status = 'Id not in registry')::INT AS listings_id_not_in_registry,
    count(*) FILTER (WHERE status = 'No id shown')::INT AS listings_no_id_shown,
    string_agg(DISTINCT trim(r.registration_business_name), '; ') AS business_names,
    'https://www.airbnb.com/users/show/' || l.host_id AS host_url,
    concat_ws(' ', l.host_name, string_agg(DISTINCT r.registration_business_name, ' '),
      string_agg(DISTINCT l.registration_id, ' ')) AS search_text
  FROM listings_active_with_host l
  JOIN (
    SELECT *, ${registrationStatusSql('r')} AS status
    FROM listings_active_with_registration r
  ) r USING (listing_id)
  GROUP BY l.host_id, l.host_name
`;

const SCOPES = {
  all: 'All',
  multi: '2+ listings',
  noId: 'Some listings show no id',
} as const;
type Scope = keyof typeof SCOPES;

const SCOPE_FILTER: Record<Scope, string | null> = {
  all: null,
  multi: 'listings >= 2',
  noId: 'listings_no_id_shown > 0',
};

export const HostsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');

  const query = useMemo(() => {
    const filters: string[] = [];
    const scopeFilter = SCOPE_FILTER[scope];
    if (scopeFilter) filters.push(scopeFilter);
    const term = search.trim();
    if (term) filters.push(`search_text ILIKE ${escapeVal(`%${term}%`)}`);
    const where = filters.map((f) => `\n  AND ${f}`).join('');
    return (
      `SELECT * EXCLUDE (search_text)\nFROM (${HOSTS_QUERY})\nWHERE true${where}` +
      `\nORDER BY listings DESC NULLS LAST, listings_in_muni DESC, host_name`
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
