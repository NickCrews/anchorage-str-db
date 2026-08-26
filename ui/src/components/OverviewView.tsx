import { useSql } from '@sqlrooms/duckdb';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  YAxis,
} from '@sqlrooms/recharts';
import { Card, CardContent, CardHeader, CardTitle, SpinnerPane } from '@sqlrooms/ui';
import type { FC } from 'react';
import { useRoomStore } from '../store';
import { StatCard } from './StatCard';

// DuckDB DATE columns come back from useSql as epoch-millisecond numbers,
// not Date instances.
const shortDate = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
const monthLabel = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });

const occupancyConfig = {
  booked: { label: 'Booked', color: 'hsl(var(--chart-1))' },
  vacant: { label: 'Vacant', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig;

const strConfig = {
  distinctStrs: { label: 'Distinct STRs', color: 'hsl(var(--chart-3))' },
} satisfies ChartConfig;

const bedroomConfig = {
  nListings: { label: 'Listings', color: 'hsl(var(--chart-4))' },
} satisfies ChartConfig;

export const OverviewView: FC = () => {
  const status = useRoomStore((s) => s.dataInit.status);
  const enabled = status === 'ready';

  const { data: kpiData, isLoading: kpiLoading } = useSql<{
    activeListings: number;
    operatingTonight: number | null;
    bookedTonight: number | null;
    distinctStrsLastYear: number;
    latestScrapeDate: number | null;
  }>({
    enabled,
    query: `
      WITH tonight AS (
        SELECT
          count(*)::INT AS operating_tonight,
          count(*) FILTER (WHERE NOT available)::INT AS booked_tonight
        FROM calendar_status
        WHERE is_current AND night_date = CURRENT_DATE
      ),
      active AS (SELECT count(*)::INT AS n FROM listings WHERE is_current),
      last_year AS (
        SELECT count(DISTINCT listing_id)::INT AS n
        FROM listing_observations
        WHERE scrape_date >= CURRENT_DATE - INTERVAL 365 DAY
      ),
      latest_run AS (SELECT max(scrape_date) AS d FROM scrape_runs)
      SELECT
        active.n AS "activeListings",
        tonight.operating_tonight AS "operatingTonight",
        tonight.booked_tonight AS "bookedTonight",
        last_year.n AS "distinctStrsLastYear",
        latest_run.d AS "latestScrapeDate"
      FROM active, tonight, last_year, latest_run
    `,
  });

  const { data: occupancyData, isLoading: occupancyLoading } = useSql<{
    nightDate: number;
    booked: number;
    vacant: number;
  }>({
    enabled,
    query: `
      SELECT
        night_date AS "nightDate",
        count(*) FILTER (WHERE NOT available)::INT AS booked,
        count(*) FILTER (WHERE available)::INT AS vacant
      FROM calendar_status
      WHERE is_current
        AND night_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL 90 DAY
      GROUP BY ALL
      ORDER BY night_date
    `,
  });

  const { data: strTrendData, isLoading: strTrendLoading } = useSql<{
    month: number;
    distinctStrs: number;
  }>({
    enabled,
    query: `
      SELECT
        date_trunc('month', scrape_date)::DATE AS "month",
        count(DISTINCT listing_id)::INT AS "distinctStrs"
      FROM listing_observations
      GROUP BY ALL
      ORDER BY month
    `,
  });

  const { data: bedroomMixData, isLoading: bedroomMixLoading } = useSql<{
    bedrooms: number | null;
    bedroomsLabel: string;
    nListings: number;
  }>({
    enabled,
    query: `
      SELECT
        bedrooms,
        coalesce(bedrooms::VARCHAR, 'Studio/unknown') AS "bedroomsLabel",
        count(*)::INT AS "nListings"
      FROM listings
      WHERE is_current
      GROUP BY ALL
      ORDER BY bedrooms NULLS FIRST
    `,
  });

  if (!enabled) {
    return <SpinnerPane className="h-full" />;
  }

  const kpi = kpiData?.toArray()[0];
  const pctBooked =
    kpi?.operatingTonight && kpi.bookedTonight != null
      ? Math.round((100 * kpi.bookedTonight) / kpi.operatingTonight)
      : null;

  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Active STR listings"
          value={kpiLoading ? '…' : (kpi?.activeListings ?? '—')}
          detail="Currently visible in Airbnb search"
        />
        <StatCard
          label="Booked tonight"
          value={kpiLoading ? '…' : (kpi?.bookedTonight ?? '—')}
          detail={
            pctBooked != null
              ? `${pctBooked}% of ${kpi?.operatingTonight} operating tonight`
              : 'No calendar data for tonight'
          }
        />
        <StatCard
          label="Distinct STRs, last 365 days"
          value={kpiLoading ? '…' : (kpi?.distinctStrsLastYear ?? '—')}
          detail="Under-counts until the archive has run a full year"
        />
        <StatCard
          label="Last scrape"
          value={
            kpiLoading
              ? '…'
              : kpi?.latestScrapeDate
                ? shortDate(kpi.latestScrapeDate)
                : '—'
          }
          detail="UTC calendar date"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Booked vs. vacant, next 90 nights
          </CardTitle>
        </CardHeader>
        <CardContent>
          {occupancyLoading ? (
            <SpinnerPane className="h-64" />
          ) : (
            <ChartContainer config={occupancyConfig} className="h-64 w-full">
              <AreaChart data={occupancyData?.toArray() ?? []}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="nightDate"
                  tickFormatter={(v: number) => shortDate(v)}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis tickLine={false} axisLine={false} width={32} />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        payload[0]?.payload?.nightDate
                          ? shortDate(payload[0].payload.nightDate)
                          : ''
                      }
                    />
                  }
                />
                <Area
                  dataKey="booked"
                  type="monotone"
                  stackId="a"
                  fill="var(--color-booked)"
                  stroke="var(--color-booked)"
                  fillOpacity={0.5}
                />
                <Area
                  dataKey="vacant"
                  type="monotone"
                  stackId="a"
                  fill="var(--color-vacant)"
                  stroke="var(--color-vacant)"
                  fillOpacity={0.5}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Distinct STRs operating, by month
            </CardTitle>
          </CardHeader>
          <CardContent>
            {strTrendLoading ? (
              <SpinnerPane className="h-56" />
            ) : (
              <ChartContainer config={strConfig} className="h-56 w-full">
                <BarChart data={strTrendData?.toArray() ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="month"
                    tickFormatter={(v: number) => monthLabel(v)}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          payload[0]?.payload?.month
                            ? monthLabel(payload[0].payload.month)
                            : ''
                        }
                      />
                    }
                  />
                  <Bar
                    dataKey="distinctStrs"
                    fill="var(--color-distinctStrs)"
                    radius={4}
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Bedroom-size mix, current inventory
            </CardTitle>
          </CardHeader>
          <CardContent>
            {bedroomMixLoading ? (
              <SpinnerPane className="h-56" />
            ) : (
              <ChartContainer config={bedroomConfig} className="h-56 w-full">
                <BarChart data={bedroomMixData?.toArray() ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="bedroomsLabel"
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="nListings"
                    fill="var(--color-nListings)"
                    radius={4}
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
