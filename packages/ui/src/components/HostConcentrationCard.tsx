import type { WasmSelection } from '@anchorage-str-db/db/rows';
import { toSql } from '@anchorage-str-db/db/sql';
import { hostListingPortfolios, listingsActive } from '@anchorage-str-db/db/viewSchema';
import { useSql } from '@sqlrooms/duckdb';
import {
  Bar,
  BarChart,
  CartesianGrid,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from '@sqlrooms/recharts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SpinnerPane,
  ToggleGroup,
  ToggleGroupItem,
} from '@sqlrooms/ui';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { useMemo, useState, type FC } from 'react';
import { pct, shortDate } from '../format';
import { useRoomStore } from '../store';

/**
 * Display cutoffs for "hosts with at least N active listings". The database
 * stores counts only; where an owner ends and an operator begins is left to
 * the reader, and the card says so.
 */
const CUTOFFS = [2, 3, 5, 10, 20] as const;

const distributionConfig = {
  listings: { label: 'Listings held', color: 'hsl(var(--chart-5))' },
} satisfies ChartConfig;

const trendConfig = {
  pctHeld: { label: '% of listings', color: 'hsl(var(--chart-5))' },
} satisfies ChartConfig;

/** Builds queries without a connection; `toSql` renders them for SQLRooms. */
const qb = new QueryBuilder();

/** The latest date `host_listing_portfolios` has counts for. */
const latestPortfolioDate = qb
  .select({ scrapeDate: sql<number>`max(${hostListingPortfolios.scrapeDate})`.as('scrape_date') })
  .from(hostListingPortfolios);

/**
 * Each host with active listings at the latest run: `host_listing_portfolios` cut down
 * to one date. Selected through the query builder, so the rows are still that
 * view's columns and the queries below read them as such under the name
 * `latest`.
 */
const latest = qb
  .select()
  .from(hostListingPortfolios)
  .where(
    and(
      eq(hostListingPortfolios.scrapeDate, latestPortfolioDate),
      gt(hostListingPortfolios.listingsActive, 0),
    ),
  )
  .as('latest');

/** Hosts by portfolio size, largest first, for the top-10 share. */
const ranked = qb.$with('ranked').as(
  qb
    .select({
      listingsActive: latest.listingsActive,
      rnk: sql<number>`row_number() OVER (ORDER BY ${latest.listingsActive} DESC, ${latest.hostId})`.as(
        'rnk',
      ),
    })
    .from(latest),
);

/** Active listings whose page was never read, so no host is known. */
const unknownHosts = qb
  .select({ unknownHost: sql<number>`count(*)::INT`.as('unknownHost') })
  .from(listingsActive)
  .where(isNull(listingsActive.hostId));

const summaryFields = (cutoff: number) => ({
  hosts: sql<number>`count(*)::INT`.as('hosts'),
  hostsAtCutoff: sql<number>`count(*) FILTER (WHERE ${ranked.listingsActive} >= ${cutoff})::INT`.as(
    'hostsAtCutoff',
  ),
  attributed: sql<number>`coalesce(sum(${ranked.listingsActive}), 0)::INT`.as('attributed'),
  heldAtCutoff:
    sql<number>`coalesce(sum(${ranked.listingsActive}) FILTER (WHERE ${ranked.listingsActive} >= ${cutoff}), 0)::INT`.as(
      'heldAtCutoff',
    ),
  heldByTop10:
    sql<number>`coalesce(sum(${ranked.listingsActive}) FILTER (WHERE ${ranked.rnk} <= 10), 0)::INT`.as(
      'heldByTop10',
    ),
  unknownHost: sql<number>`${unknownHosts}`.as('unknownHost'),
});

type SummaryRow = WasmSelection<ReturnType<typeof summaryFields>>;

const summaryQuery = (cutoff: number) =>
  qb.with(ranked).select(summaryFields(cutoff)).from(ranked);

const DISTRIBUTION_FIELDS = {
  bucket: sql<string>`CASE
        WHEN ${latest.listingsActive} >= 20 THEN '20+'
        WHEN ${latest.listingsActive} >= 10 THEN '10–19'
        WHEN ${latest.listingsActive} >= 5 THEN '5–9'
        WHEN ${latest.listingsActive} >= 3 THEN '3–4'
        ELSE ${latest.listingsActive}::VARCHAR
      END`.as('bucket'),
  listings: sql<number>`sum(${latest.listingsActive})::INT`.as('listings'),
};

const DISTRIBUTION_QUERY = qb
  .select(DISTRIBUTION_FIELDS)
  .from(latest)
  .groupBy(sql`"bucket"`)
  .orderBy(sql`min(${latest.listingsActive})`);

const trendFields = (cutoff: number) => ({
  scrapeDate: sql<number>`${hostListingPortfolios.scrapeDate}`.as('scrapeDate'),
  pctHeld: sql<number | null>`round(
        100.0 * coalesce(
          sum(${hostListingPortfolios.listingsActive})
            FILTER (WHERE ${hostListingPortfolios.listingsActive} >= ${cutoff}),
          0
        ) / nullif(sum(${hostListingPortfolios.listingsActive}), 0),
        1
      )::DOUBLE`.as('pctHeld'),
});

type TrendRow = WasmSelection<ReturnType<typeof trendFields>>;

const trendQuery = (cutoff: number) =>
  qb
    .select(trendFields(cutoff))
    .from(hostListingPortfolios)
    .groupBy(hostListingPortfolios.scrapeDate)
    .orderBy(asc(hostListingPortfolios.scrapeDate));

export const HostConcentrationCard: FC = () => {
  const enabled = useRoomStore((s) => s.dataInit.status) === 'ready';
  const [cutoff, setCutoff] = useState<number>(CUTOFFS[0]);

  const { data: summaryData, isLoading: summaryLoading } = useSql<SummaryRow>({
    enabled,
    query: useMemo(() => toSql(summaryQuery(cutoff)), [cutoff]),
  });

  const { data: distributionData, isLoading: distributionLoading } = useSql<
    WasmSelection<typeof DISTRIBUTION_FIELDS>
  >({ enabled, query: toSql(DISTRIBUTION_QUERY) });

  const { data: trendData, isLoading: trendLoading } = useSql<TrendRow>({
    enabled,
    query: useMemo(() => toSql(trendQuery(cutoff)), [cutoff]),
  });

  const s = summaryData?.toArray()[0];

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Host concentration</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Hosts with at least</span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={String(cutoff)}
              onValueChange={(v) => v && setCutoff(Number(v))}
            >
              {CUTOFFS.map((n) => (
                <ToggleGroupItem key={n} value={String(n)} className="px-2">
                  {n}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="text-muted-foreground">active listings</span>
          </div>
        </div>
        <CardDescription className="text-xs">
          The cutoff is a display choice: the database stores each host's
          listing counts and no commercial-host threshold. These are Anchorage
          listing portfolios: they cover only listings inside the
          Municipality, so a host with listings elsewhere is undercounted
          here. A host is an Airbnb account, so one property manager's
          account can list for many owners.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summaryLoading ? (
          <SpinnerPane className="h-12" />
        ) : s ? (
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{s.hostsAtCutoff}</span> of{' '}
            <span className="tabular-nums">{s.hosts}</span> hosts hold {cutoff}+ live
            listings, together{' '}
            <span className="font-semibold tabular-nums">
              {pct(s.heldAtCutoff, s.attributed)}
            </span>{' '}
            ({s.heldAtCutoff} of {s.attributed}) of listings with a known host. The 10
            largest hosts hold {pct(s.heldByTop10, s.attributed)}.
            {s.unknownHost > 0 ? (
              <span className="text-muted-foreground">
                {' '}
                {s.unknownHost} active listings have no known host and are left out.
              </span>
            ) : null}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <div className="text-muted-foreground mb-1 text-xs">
              Active listings held, by the host's portfolio size
            </div>
            {distributionLoading ? (
              <SpinnerPane className="h-56" />
            ) : (
              <ChartContainer config={distributionConfig} className="h-56 w-full">
                <BarChart data={distributionData?.toArray() ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="bucket" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="listings" fill="var(--color-listings)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </div>
          <div>
            <div className="text-muted-foreground mb-1 text-xs">
              % of listings held by hosts with {cutoff}+, by scrape date
            </div>
            {trendLoading ? (
              <SpinnerPane className="h-56" />
            ) : (
              <ChartContainer config={trendConfig} className="h-56 w-full">
                <LineChart data={trendData?.toArray() ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="scrapeDate"
                    tickFormatter={(v: number) => shortDate(v)}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis tickLine={false} axisLine={false} width={32} domain={[0, 100]} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          payload[0]?.payload?.scrapeDate
                            ? shortDate(payload[0].payload.scrapeDate)
                            : ''
                        }
                      />
                    }
                  />
                  <Line
                    dataKey="pctHeld"
                    type="monotone"
                    stroke="var(--color-pctHeld)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
