import { useMemo, useState, type FC } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { int, money, monthLabel, pct1 } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { revenueCol } from '../model';
import { axisProps, Caveat, CATEGORY, ChartBox, COLOR, N, Segmented, Select, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

/** Anchorage host listing portfolio sizes, as bins. Where a casual host ends is the reader's call. */
const SIZE_BIN = `CASE
  WHEN h.listings = 1 THEN '1'
  WHEN h.listings = 2 THEN '2'
  WHEN h.listings <= 5 THEN '3–5'
  WHEN h.listings <= 10 THEN '6–10'
  ELSE '11+'
END`;

/** Per host for one month: listings with calendar data and their summed revenue. */
const hostsSql = (month: string, col: string, where = 'true') => `
  WITH m AS (
    SELECT l.host_id, m.listing_id, m.${col} AS revenue
    FROM est_listing_months m JOIN est_listings l USING (listing_id)
    WHERE m.month = DATE '${month}' AND l.host_id IS NOT NULL AND ${where}
  )
  SELECT host_id, count(*) AS listings, coalesce(sum(revenue), 0) AS revenue
  FROM m GROUP BY host_id
`;

const HOST_NAMES = `
  SELECT host_id, name AS host_name
  FROM hosts
  QUALIFY row_number() OVER (PARTITION BY host_id ORDER BY valid_from DESC) = 1
`;

type Top = 'sizes' | 'top' | 'host';
interface VisualState {
  top: Top;
  month: string;
}

export const HostRevenue: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  // As text: host ids can exceed 2^53.
  const [hostId, setHostId] = useState<string | null>(null);

  const { row: s } = useRow<{
    hosts: number;
    singleShareHosts: number;
    singleShareRevenue: number;
    bigShareHosts: number;
    bigShareRevenue: number;
    topHostId: string;
    topHostName: string;
    topHostListings: number;
    topHostRevenue: number;
  }>(
    `WITH h AS (${hostsSql(focus, 'revenue')}),
     n AS (${HOST_NAMES})
     SELECT
       count(*)::INT AS hosts,
       count(*) FILTER (WHERE listings = 1) / count(*) AS "singleShareHosts",
       sum(revenue) FILTER (WHERE listings = 1) / sum(revenue) AS "singleShareRevenue",
       count(*) FILTER (WHERE listings >= 6) / count(*) AS "bigShareHosts",
       sum(revenue) FILTER (WHERE listings >= 6) / sum(revenue) AS "bigShareRevenue",
       arg_max(h.host_id, revenue)::VARCHAR AS "topHostId",
       arg_max(host_name, revenue) AS "topHostName",
       arg_max(listings, revenue)::INT AS "topHostListings",
       max(revenue) AS "topHostRevenue"
     FROM h LEFT JOIN n USING (host_id)`,
    { enabled: !!focus },
  );

  return (
    <Chapter
      id="q2"
      title="Who runs them, and how much do they make?"
      lede={
        <>
          Every listing is run by a host: the Airbnb account behind it. A host might be a homeowner renting
          out one place, or a management company running dozens for different owners. We count only their
          listings in Anchorage, so hosts with listings elsewhere are bigger than they look here.
        </>
      }
      steps={[
        <>
          Of <N>{int(s?.hosts)}</N> hosts, <N>{pct1(s?.singleShareHosts)}</N> run just one listing. Together they
          earned <N>{pct1(s?.singleShareRevenue)}</N> of the money.
        </>,
        <>
          Hosts with six or more listings are only <N>{pct1(s?.bigShareHosts)}</N> of hosts, but they earned{' '}
          <N>{pct1(s?.bigShareRevenue)}</N> of the money. Drag across the <em>host's listings</em> column at the top of
          the table to see where the biggest operations are.
          <Caveat>There is no official line between a hobby and a business; compare the groups yourself.</Caveat>
        </>,
        <>
          The hosts who earned the most. The top one, <N>{s?.topHostName}</N>, ran <N>{int(s?.topHostListings)}</N>{' '}
          listings and earned about <N>{money(s?.topHostRevenue)}</N> in the month. Click a row to see that host
          month by month.
        </>,
        <>One host's earnings month by month, split by listing. Faded months haven't happened yet.</>,
      ]}
      visual={(step) => (
        <Visual step={step} focusMonth={focus} hostId={hostId ?? s?.topHostId ?? null} onPickHost={setHostId} />
      )}
    />
  );
};

const Visual: FC<{ step: number; focusMonth: string; hostId: string | null; onPickHost: (id: string) => void }> = ({
  step,
  focusMonth,
  hostId,
  onPickHost,
}) => {
  const months = useStartedMonths();
  const { state, update, exploring, reset } = useStepState<VisualState>(step, [
    { top: 'sizes', month: focusMonth },
    { top: 'sizes', month: focusMonth },
    { top: 'top', month: focusMonth },
    { top: 'host', month: focusMonth },
  ]);
  return (
    <XfProvider chapterId="q2" month={state.month}>
      <ChapterGrid
      exploring={exploring}
      onReset={reset}
      controls={
        <>
          <Segmented
            value={state.top}
            options={[
              { value: 'sizes', label: 'By size of host' },
              { value: 'top', label: 'Largest hosts' },
              { value: 'host', label: 'One host' },
            ]}
            onChange={(top) => update({ top })}
          />
          <Select
            label="Month"
            value={state.month}
            options={months.map((m) => ({ value: m.value, label: m.label }))}
            onChange={(month) => update({ month })}
          />
        </>
      }
      chart={
        state.top === 'sizes' ? (
          <Sizes state={state} />
        ) : state.top === 'top' ? (
          <TopHosts
            state={state}
            onPick={(id) => {
              onPickHost(id);
              update({ top: 'host' });
            }}
          />
        ) : (
          <OneHost hostId={hostId} />
        )
      }
      caption="Hosts grouped by how many Anchorage listings they run, with each group's share of hosts, listings and earnings."
      side={<XfSide mapColor={{ field: "host's listings", type: 'quantile', scheme: 'Purples', title: "Host's listings" }} columns={TABLE_COLUMNS.host} />}
    />
  </XfProvider>
  );
};

const Sizes: FC<{ state: VisualState }> = ({ state }) => {
  const xf = useXf();
  const { model } = useStory();
  const { rows, isLoading, error } = useRows<{ size: string; hosts: number; listings: number; revenue: number }>(
    `WITH h AS (${hostsSql(state.month, revenueCol(model), selectedListingsSql(xf, 'l'))}),
     t AS (SELECT count(*) AS hosts, sum(listings) AS listings, sum(revenue) AS revenue FROM h)
     SELECT ${SIZE_BIN} AS size,
       count(*) / any_value(t.hosts) AS hosts,
       sum(h.listings) / any_value(t.listings) AS listings,
       sum(h.revenue) / nullif(any_value(t.revenue), 0) AS revenue
     FROM h, t GROUP BY size ORDER BY min(h.listings)`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 12, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="size" {...axisProps} label={{ value: 'Listings per host', position: 'insideBottom', offset: -6, fontSize: 11 }} />
          <YAxis {...axisProps} width={40} tickFormatter={(n: number) => pct1(n)} />
          <Tooltip {...tooltipProps} formatter={(n) => pct1(n as number)} />
          <Legend verticalAlign="top" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="hosts" name="Share of hosts" fill={CATEGORY[5]} isAnimationActive={false} />
          <Bar dataKey="listings" name="Share of listings" fill={CATEGORY[0]} isAnimationActive={false} />
          <Bar dataKey="revenue" name="Share of earnings" fill={COLOR.booked} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const TopHosts: FC<{ state: VisualState; onPick: (id: string) => void }> = ({ state, onPick }) => {
  const xf = useXf();
  const { model } = useStory();
  const { rows, isLoading, error } = useRows<{ hostId: string; hostName: string; listings: number; revenue: number; share: number }>(
    `WITH h AS (${hostsSql(state.month, revenueCol(model), selectedListingsSql(xf, 'l'))}),
     n AS (${HOST_NAMES})
     SELECT h.host_id::VARCHAR AS "hostId", coalesce(host_name, '(unnamed)') AS "hostName", listings::INT AS listings, revenue,
       revenue / sum(revenue) OVER () AS share
     FROM h LEFT JOIN n USING (host_id)
     ORDER BY revenue DESC LIMIT 40`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <div className="h-full overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-card text-muted-foreground sticky top-0 text-left">
            <tr>
              <th className="py-1 pr-2 font-normal">#</th>
              <th className="py-1 pr-2 font-normal">Host (click for month by month)</th>
              <th className="py-1 pr-2 text-right font-normal">Listings</th>
              <th className="py-1 pr-2 text-right font-normal">Earned</th>
              <th className="py-1 text-right font-normal">Share of all</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.hostId} onClick={() => onPick(r.hostId)} className="hover:bg-muted cursor-pointer border-t">
                <td className="text-muted-foreground py-1 pr-2">{i + 1}</td>
                <td className="py-1 pr-2">
                  {r.hostName}{' '}
                  <a
                    href={`https://www.airbnb.com/users/show/${r.hostId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    profile
                  </a>
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.listings}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{money(r.revenue)}</td>
                <td className="py-1 text-right tabular-nums">{pct1(r.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartBox>
  );
};

const OneHost: FC<{ hostId: string | null }> = ({ hostId }) => {
  const { model } = useStory();
  const col = revenueCol(model);
  const id = `TRY_CAST('${(hostId ?? '0').replaceAll("'", "''")}' AS BIGINT)`;
  const { row: info } = useRow<{ name: string }>(`SELECT host_name AS name FROM (${HOST_NAMES}) WHERE host_id = ${id}`, {
    enabled: hostId != null,
  });
  const { rows, isLoading, error } = useRows<{ month: number; listingName: string; revenue: number; isPast: boolean }>(
    `WITH m AS (
       SELECT m.month, l.listing_id, l.name, coalesce(m.${col}, 0) AS revenue, m.is_past
       FROM est_listing_months m JOIN est_listings l USING (listing_id)
       WHERE l.host_id = ${id}
     ),
     top AS (SELECT listing_id FROM m GROUP BY listing_id ORDER BY sum(revenue) DESC LIMIT 7)
     SELECT month,
       CASE WHEN listing_id IN (SELECT listing_id FROM top) THEN name ELSE 'Other listings' END AS "listingName",
       sum(revenue) AS revenue, bool_and(is_past) AS "isPast"
     FROM m GROUP BY ALL ORDER BY month`,
    { enabled: hostId != null },
  );
  const { data, names } = useMemo(() => {
    const byMonth = new Map<number, Record<string, number | string>>();
    const names: string[] = [];
    for (const r of rows) {
      if (!names.includes(r.listingName)) names.push(r.listingName);
      const entry = byMonth.get(r.month) ?? { label: monthLabel(r.month) + (r.isPast ? '' : '*') };
      entry[r.listingName] = r.revenue;
      byMonth.set(r.month, entry);
    }
    return { data: [...byMonth.values()], names };
  }, [rows]);
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <div className="flex h-full flex-col">
        <div className="truncate px-1 text-xs">
          <span className="font-medium">{info?.name ?? 'One host'}</span>
          <span className="text-muted-foreground"> · earnings by month · * booked so far</span>
        </div>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" {...axisProps} />
              <YAxis {...axisProps} width={48} tickFormatter={(n: number) => money(n, true)} />
              <Tooltip {...tooltipProps} formatter={(n) => money(n as number)} />
              {names.map((name, i) => (
                <Bar key={name} dataKey={name} stackId="a" fill={CATEGORY[i % CATEGORY.length]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ChartBox>
  );
};
