import {QueryDataTable} from '@sqlrooms/data-table';
import {escapeVal} from '@sqlrooms/duckdb';
import {Badge, Input} from '@sqlrooms/ui';
import {useMemo, useState, type FC} from 'react';
import {DataStatusGate} from './DataStatusGate';

const BASE_QUERY = `
  SELECT
    l.listing_id,
    l.name,
    l.property_title,
    l.bedrooms,
    l.beds,
    l.bathrooms,
    l.guest_capacity,
    o.rating_value,
    o.review_count,
    o.price_hint_per_night,
    o.price_qualifier,
    l.first_seen_date,
    l.last_seen_date,
    l.url
  FROM listings l
  LEFT JOIN (
    SELECT *
    FROM listing_observations
    QUALIFY row_number() OVER (PARTITION BY listing_id ORDER BY scrape_date DESC) = 1
  ) o ON o.listing_id = l.listing_id
  WHERE l.is_current
`;

export const ListingsView: FC = () => {
  const [search, setSearch] = useState('');

  const query = useMemo(() => {
    const term = search.trim();
    if (!term) return `${BASE_QUERY}\n  ORDER BY l.last_seen_date DESC`;
    const pattern = escapeVal(`%${term}%`);
    return `${BASE_QUERY}\n  AND (l.name ILIKE ${pattern} OR l.property_title ILIKE ${pattern})\n  ORDER BY l.last_seen_date DESC`;
  }, [search]);

  return (
    <DataStatusGate>
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Badge variant="secondary">currently active listings</Badge>
      </div>
      <div className="min-h-0 flex-1">
        <QueryDataTable query={query} pageSize={50} />
      </div>
    </div>
    </DataStatusGate>
  );
};
