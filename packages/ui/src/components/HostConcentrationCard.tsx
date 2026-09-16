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
import { useState, type FC } from 'react';
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

// Each host with active listings at the latest run.
const NOW = `
  SELECT host_id, listings_active
  FROM host_listing_portfolios
  WHERE scrape_date = (SELECT max(scrape_date) FROM host_listing_portfolios)
    AND listings_active > 0
`;

export const HostConcentrationCard: FC = () => {
  const enabled = useRoomStore((s) => s.dataInit.status) === 'ready';
  const [cutoff, setCutoff] = useState<number>(CUTOFFS[0]);

  const { data: summaryData, isLoading: summaryLoading } = useSql<{
    hosts: number;
    hostsAtCutoff: number;
    attributed: number;
    heldAtCutoff: number;
    heldByTop10: number;
    unknownHost: number;
  }>({
    enabled,
    query: `
      WITH ranked AS (
        SELECT listings_active, row_number() OVER (ORDER BY listings_active DESC, host_id) AS rnk
        FROM (${NOW})
      )
      SELECT
        count(*)::INT AS "hosts",
        count(*) FILTER (WHERE listings_active >= ${cutoff})::INT AS "hostsAtCutoff",
        coalesce(sum(listings_active), 0)::INT AS "attributed",
        coalesce(sum(listings_active) FILTER (WHERE listings_active >= ${cutoff}), 0)::INT AS "heldAtCutoff",
        coalesce(sum(listings_active) FILTER (WHERE rnk <= 10), 0)::INT AS "heldByTop10",
        (SELECT count(*) FROM listings_active WHERE host_id IS NULL)::INT AS "unknownHost"
      FROM ranked
    `,
  });

  const { data: distributionData, isLoading: distributionLoading } = useSql<{
    bucket: string;
    listings: number;
  }>({
    enabled,
    query: `
      SELECT
        CASE
          WHEN listings_active >= 20 THEN '20+'
          WHEN listings_active >= 10 THEN '10–19'
          WHEN listings_active >= 5 THEN '5–9'
          WHEN listings_active >= 3 THEN '3–4'
          ELSE listings_active::VARCHAR
        END AS "bucket",
        sum(listings_active)::INT AS "listings"
      FROM (${NOW})
      GROUP BY 1
      ORDER BY min(listings_active)
    `,
  });

  const { data: trendData, isLoading: trendLoading } = useSql<{
    scrapeDate: number;
    pctHeld: number | null;
  }>({
    enabled,
    query: `
      SELECT
        scrape_date AS "scrapeDate",
        round(
          100.0 * coalesce(sum(listings_active) FILTER (WHERE listings_active >= ${cutoff}), 0)
            / nullif(sum(listings_active), 0),
          1
        )::DOUBLE AS "pctHeld"
      FROM host_listing_portfolios
      GROUP BY scrape_date
      ORDER BY scrape_date
    `,
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
