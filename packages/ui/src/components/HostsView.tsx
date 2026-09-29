import {toSql} from '@anchorage-str-db/db/sql';
import {QueryDataTable, QueryDataTableActionsMenu} from '@sqlrooms/data-table';
import {Input, ToggleGroup, ToggleGroupItem} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {hostsTableQuery, SCOPES, type Scope} from '../queries/hosts';
import {DataStatusGate} from './DataStatusGate';

export const HostsView: FC = () => {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');

  const query = useMemo(() => toSql(hostsTableQuery(scope, search)), [search, scope]);

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
