import type { FC } from 'react';
import { Bar, BarChart, Cell, ErrorBar, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money, monthLabel, monthName } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { useStory } from '../context';
import { revenueCol } from '../model';
import { axisProps, COLOR, tooltipProps } from '../ui';
import { useXf } from './context';

const bedroomsLabel = (b: string | undefined) =>
  !b || b === 'Not listed' ? null : b === 'Studio' ? 'Studio' : `${b} bedroom${b === '1' ? '' : 's'}`;

/**
 * The details of the listing picked on the map or in the table: what it is,
 * who runs and owns it, and its estimated revenue month by month.
 */
export const ListingDetail: FC = () => {
  const { picked, setPicked, table } = useXf();
  const { model } = useStory();
  const id = (picked ?? '0').replaceAll("'", "''");
  const { row: info } = useRow<{
    listing: string;
    url: string;
    type: string;
    bedrooms: string;
    area: string;
    council: string | null;
    host: string;
    hostId: string | null;
    hostListings: number;
    registration: string;
    owner: string | null;
    ownerMail: string;
    livesThere: string;
    revenue: number | null;
    booked: number;
    closed: number;
    open: number;
    price: number | null;
    frehmReason: string;
  }>(
    `SELECT "listing", url, "type", "bedrooms", "area", "community council" AS council, "host", host_id AS "hostId",
       "host's listings"::INT AS "hostListings", "registration", "owner", "owner's mail goes to" AS "ownerMail",
       "owner lives there?" AS "livesThere", "revenue", "nights booked"::INT AS booked, "nights closed"::INT AS closed,
       "nights open"::INT AS open, "nightly price" AS price,
       "FREHM reason" AS "frehmReason"
     FROM ${table} WHERE listing_id = '${id}'`,
    { enabled: picked != null },
  );
  const col = revenueCol(model);
  const { rows } = useRows<{ month: number; low: number; value: number; high: number; isPast: boolean }>(
    `SELECT month, coalesce(revenue_low, 0) AS low, coalesce(${col}, 0) AS value, coalesce(revenue_high, 0) AS high,
       is_past AS "isPast"
     FROM est_listing_months WHERE listing_id = TRY_CAST('${id}' AS BIGINT) ORDER BY month`,
    { enabled: picked != null },
  );
  if (picked == null) return null;
  const data = rows.map((r) => ({ ...r, label: monthLabel(r.month), err: [r.value - r.low, r.high - r.value] }));

  return (
    <div className="bg-background/95 absolute top-2 left-2 z-30 flex max-h-[calc(100%-1rem)] w-80 flex-col overflow-hidden rounded-md border text-xs shadow-lg backdrop-blur">
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <a className="block truncate font-medium underline" href={info?.url} target="_blank" rel="noreferrer">
            {info?.listing ?? '…'}
          </a>
          <div className="text-muted-foreground">{[info?.type, bedroomsLabel(info?.bedrooms), info?.area].filter(Boolean).join(' · ')}</div>
        </div>
        <button onClick={() => setPicked(null)} className="text-muted-foreground hover:text-foreground px-1 text-base leading-none" aria-label="Close">
          ×
        </button>
      </div>
      <div className="overflow-auto px-3 py-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-foreground">This month</dt>
          <dd>
            About {money(info?.revenue)} · {info?.booked} nights booked, {info?.open} open, {info?.closed} closed by the host
          </dd>
          <dt className="text-muted-foreground">Asking price</dt>
          <dd>{money(info?.price)} a night</dd>
          <dt className="text-muted-foreground">Run by</dt>
          <dd>
            {info?.hostId ? (
              <a className="underline" href={`https://www.airbnb.com/users/show/${info.hostId}`} target="_blank" rel="noreferrer">
                {info.host}
              </a>
            ) : (
              info?.host
            )}
            , who has {info?.hostListings} listing{info?.hostListings === 1 ? '' : 's'} in Anchorage
          </dd>
          <dt className="text-muted-foreground">Muni registration</dt>
          <dd>{info?.registration}</dd>
          {info?.council && (
            <>
              <dt className="text-muted-foreground">Community council</dt>
              <dd>{info.council}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Owner of record</dt>
          <dd>
            {info?.owner
              ? `${info.owner}; mail goes to ${info.ownerMail.replace(/^(In|Elsewhere|Outside)/, (w) => w.toLowerCase())}`
              : 'Not known'}
          </dd>
          <dt className="text-muted-foreground">Owner lives there?</dt>
          <dd>{info?.livesThere}</dd>
          <dt className="text-muted-foreground">FREHM?</dt>
          <dd>{info?.frehmReason}</dd>
        </dl>
        <div className="mt-2 h-28">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <XAxis dataKey="label" {...axisProps} tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} />
              <YAxis {...axisProps} width={36} tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(n: number) => money(n, true)} />
              <Tooltip
                {...tooltipProps}
                content={({ payload }) => {
                  const r = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  return r ? (
                    <div className="bg-popover rounded-md border p-1.5 text-[11px] shadow">
                      {monthName(r.month)}
                      {r.isPast ? '' : ' (booked so far)'}: about {money(r.value)} (range {money(r.low)} – {money(r.high)})
                    </div>
                  ) : null;
                }}
              />
              <Bar dataKey="value" fill={COLOR.primary} isAnimationActive={false}>
                <ErrorBar dataKey="err" width={3} stroke="hsl(var(--foreground))" strokeOpacity={0.5} />
                {data.map((r) => (
                  <Cell key={r.month} fillOpacity={r.isPast ? 1 : 0.4} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-muted-foreground mt-1">
          Estimated revenue by month. Lines show the low-to-high range; faded months haven't happened yet and show only
          bookings made so far.
        </p>
      </div>
    </div>
  );
};
