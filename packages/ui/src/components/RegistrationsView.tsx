import {toSql} from '@anchorage-str-db/db/sql';
import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {registrationsTableQuery, SCOPES, type Scope} from '../queries/registrations';
import {DataStatusGate} from './DataStatusGate';

export const RegistrationsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('active');

  const query = useMemo(
    () => toSql(registrationsTableQuery(scope, search)),
    [search, scope],
  );

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
            of Anchorage. A registrant registers a unit with the Muni and gets
            an id like STR20261754, which they are expected to show on their
            listing. The Muni publishes only active registrations, so one that
            is no longer published has lapsed or been withdrawn.
          </p>
          <p>
            A <strong>listing</strong> is an Airbnb page. A{' '}
            <strong>host</strong> is the Airbnb account running it, often a
            property manager. The only thing tying a listing to a
            registration is the id on the listing page. Most registrations
            are shown by one listing. Some are shown by several, such as
            private rooms in one house. Some are shown by none: the unit
            may be listed on another site, not operating, or listed without
            its id.
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
