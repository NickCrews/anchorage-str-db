import { useSql } from '@sqlrooms/duckdb';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
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
} from '@sqlrooms/ui';
import type { FC } from 'react';
import { monthLabel, pct, shortDate } from '../format';
import { useRoomStore } from '../store';
import { DataStatusGate } from './DataStatusGate';
import { HostConcentrationCard } from './HostConcentrationCard';
import { RegistrationCard } from './RegistrationCard';
import { StatCard } from './StatCard';

const occupancyConfig = {
  booked: { label: 'Booked', color: 'hsl(var(--chart-1))' },
  vacant: { label: 'Vacant', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig;

const strConfig = {
  distinctStrs: { label: 'Distinct STRs', color: 'hsl(var(--chart-3))' },
} satisfies ChartConfig;

const listingAgeConfig = {
  fromReview: { label: 'Dated by first review', color: 'hsl(var(--chart-3))' },
  fromFirstSeen: { label: 'Dated by first scrape', color: 'hsl(var(--chart-4))' },
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
    registrationsCurrent: number;
    listingsRegistered: number;
    latestRegistryDate: number | null;
  }>({
    enabled,
    query: `
      WITH tonight AS (
        SELECT
          count(*)::INT AS operating_tonight,
          count(*) FILTER (WHERE NOT available)::INT AS booked_tonight
        FROM calendar_current
        WHERE night_date = CURRENT_DATE
      ),
      active AS (SELECT count(*)::INT AS n FROM listings WHERE is_current),
      last_year AS (
        SELECT count(DISTINCT listing_id)::INT AS n
        FROM airbnb_listing_observations
        WHERE scrape_date >= CURRENT_DATE - INTERVAL 365 DAY
      ),
      latest_run AS (SELECT max(scrape_date) AS d FROM airbnb_scrape_runs),
      registry AS (
        SELECT
          (SELECT count(*) FROM registrations_current)::INT AS n,
          (SELECT max(scrape_date) FROM muni_str_registry_runs WHERE registrations_seen IS NOT NULL) AS d
      ),
      registered AS (
        SELECT count(*)::INT AS n
        FROM listings_current_with_registration
        WHERE registration_is_current
      )
      SELECT
        active.n AS "activeListings",
        tonight.operating_tonight AS "operatingTonight",
        tonight.booked_tonight AS "bookedTonight",
        last_year.n AS "distinctStrsLastYear",
        latest_run.d AS "latestScrapeDate",
        registry.n AS "registrationsCurrent",
        registered.n AS "listingsRegistered",
        registry.d AS "latestRegistryDate"
      FROM active, tonight, last_year, latest_run, registry, registered
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
      FROM calendar_current
      WHERE night_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL 90 DAY
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
      FROM airbnb_listing_observations
      GROUP BY ALL
      ORDER BY month
    `,
  });

  // A listing's `first_available_date_est` comes from its first review when
  // that predates the first scrape, and is otherwise `first_seen_date`, which
  // makes a listing look newer than it may be.
  const { data: listingAgeData, isLoading: listingAgeLoading } = useSql<{
    year: string;
    fromReview: number;
    fromFirstSeen: number;
    reviewsUnread: number;
  }>({
    enabled,
    query: `
      SELECT
        year(l.first_available_date_est)::VARCHAR AS "year",
        count(*) FILTER (WHERE coalesce(l.first_review_date <= l.first_seen_date, false))::INT
          AS "fromReview",
        count(*) FILTER (WHERE NOT coalesce(l.first_review_date <= l.first_seen_date, false))::INT
          AS "fromFirstSeen",
        count(*) FILTER (WHERE r.listing_id IS NULL)::INT AS "reviewsUnread"
      FROM listings_current l
      LEFT JOIN airbnb_listing_first_reviews r USING (listing_id)
      GROUP BY ALL
      ORDER BY "year"
    `,
  });

  // `bedrooms` is Airbnb's text ("2 bedrooms", "Studio"); rooms usually have none.
  const { data: bedroomMixData, isLoading: bedroomMixLoading } = useSql<{
    bedroomsLabel: string;
    nListings: number;
  }>({
    enabled,
    query: `
      SELECT
        coalesce(bedrooms, 'Not listed') AS "bedroomsLabel",
        count(*)::INT AS "nListings"
      FROM listings
      WHERE is_current
      GROUP BY bedrooms
      ORDER BY
        bedrooms IS NULL,
        try_cast(regexp_extract(bedrooms, '^\\d+') AS INTEGER) NULLS FIRST,
        bedrooms
    `,
  });

  const kpi = kpiData?.toArray()[0];
  const listingAge = listingAgeData?.toArray() ?? [];
  const reviewsUnread = listingAge.reduce((sum, row) => sum + row.reviewsUnread, 0);
  const pctBooked =
    kpi?.operatingTonight && kpi.bookedTonight != null
      ? Math.round((100 * kpi.bookedTonight) / kpi.operatingTonight)
      : null;

  return (
    <DataStatusGate>
    <div className="h-full space-y-4 overflow-auto p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
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
          detail={
            kpi?.latestRegistryDate
              ? `UTC date. Registry last read ${shortDate(kpi.latestRegistryDate)}`
              : 'UTC date. No registry run yet'
          }
        />
        <StatCard
          label="Current Muni STR registrations"
          value={kpiLoading ? '…' : (kpi?.registrationsCurrent ?? '—')}
          detail="Published by the Municipal Clerk"
        />
        <StatCard
          label="Listings showing a current registration"
          value={kpiLoading ? '…' : (kpi?.listingsRegistered ?? '—')}
          detail={
            kpi?.activeListings
              ? `${pct(kpi.listingsRegistered, kpi.activeListings)} of active listings`
              : undefined
          }
        />
      </div>

      <RegistrationCard />

      <HostConcentrationCard />

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
              Current listings by year first available
            </CardTitle>
            <CardDescription className="text-xs">
              The year of a listing's first review, or of the first scrape that
              saw it if that is earlier. Either can only be late, so older years
              are under-counted.
              {reviewsUnread > 0
                ? ` ${reviewsUnread} listings' reviews are not read yet and are dated by first scrape.`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {listingAgeLoading ? (
              <SpinnerPane className="h-56" />
            ) : (
              <ChartContainer config={listingAgeConfig} className="h-56 w-full">
                <BarChart data={listingAge}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="year" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={40} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="fromReview" stackId="age" fill="var(--color-fromReview)" />
                  <Bar
                    dataKey="fromFirstSeen"
                    stackId="age"
                    fill="var(--color-fromFirstSeen)"
                    radius={[4, 4, 0, 0]}
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
    </DataStatusGate>
  );
};
