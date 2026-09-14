import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {escapeVal} from '@sqlrooms/duckdb';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {DataStatusGate} from './DataStatusGate';

/**
 * `license_*` columns come from the latest CityView license page read, which
 * is re-read about weekly, so they can be NULL for a new registration.
 * `airbnb_listings_current` counts current Airbnb listings showing the number.
 */
const BASE_QUERY = `
  SELECT
    registration_number,
    business_name,
    location,
    community_council,
    parcel_type,
    parcel_id,
    airbnb_listings_current,
    issued_date,
    expires_date,
    status,
    license_status,
    license_description,
    license_read_date,
    first_seen_date,
    last_seen_date,
    is_current,
    status_url
  FROM registrations
  WHERE true
`;

const SCOPES = {
  current: 'Current',
  unlisted: 'Current, no Airbnb listing',
  lapsed: 'No longer published',
  all: 'All',
} as const;
type Scope = keyof typeof SCOPES;

const SCOPE_FILTER: Record<Scope, string | null> = {
  current: 'is_current',
  unlisted: 'is_current AND airbnb_listings_current = 0',
  lapsed: 'NOT is_current',
  all: null,
};

export const RegistrationsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('current');

  const query = useMemo(() => {
    const filters: string[] = [];
    const scopeFilter = SCOPE_FILTER[scope];
    if (scopeFilter) filters.push(scopeFilter);
    const term = search.trim();
    if (term) {
      const pattern = escapeVal(`%${term}%`);
      filters.push(
        `(registration_number ILIKE ${pattern} OR business_name ILIKE ${pattern}` +
          ` OR location ILIKE ${pattern} OR community_council ILIKE ${pattern}` +
          ` OR parcel_id ILIKE ${pattern} OR license_description ILIKE ${pattern})`,
      );
    }
    const where = filters.map((f) => `\n  AND ${f}`).join('');
    return `${BASE_QUERY}${where}\n  ORDER BY issued_date DESC NULLS LAST, registration_number`;
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
