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

// "Not available" covers booked and host-blocked nights together, which is
// all Airbnb's calendar publishes. Naming it "booked" would overstate
// occupancy.
const availabilityConfig = {
  notAvailable: { label: 'Not available', color: 'hsl(var(--chart-1))' },
  available: { label: 'Available', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig;

const strConfig = {
  distinctListings: { label: 'Distinct listings', color: 'hsl(var(--chart-3))' },
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
    withCalendarTonight: number | null;
    notAvailableTonight: number | null;
    distinctListingsLastYear: number;
    registrationsActive: number;
    listingsRegistered: number;
    airbnbDate: number | null;
    licensesDate: number | null;
    parcelsDate: number | null;
  }>({
    enabled,
    query: `
      WITH tonight AS (
        SELECT
          count(*)::INT AS with_calendar_tonight,
          count(*) FILTER (WHERE NOT available)::INT AS not_available_tonight
        FROM calendar_current
        WHERE night_date = CURRENT_DATE
      ),
      active AS (SELECT count(*)::INT AS n FROM listings WHERE is_active),
      last_year AS (
        SELECT count(DISTINCT listing_id)::INT AS n
        FROM airbnb_listing_observations
        WHERE scrape_date >= CURRENT_DATE - INTERVAL 365 DAY
      ),
      registry AS (SELECT count(*)::INT AS n FROM registrations_active),
      freshness AS (
        SELECT
          max(last_success_date) FILTER (WHERE source = 'airbnb') AS airbnb,
          max(last_success_date) FILTER (WHERE source = 'muni_licenses') AS licenses,
          max(last_success_date) FILTER (WHERE source = 'property_parcels') AS parcels
        FROM source_freshness
      ),
      registered AS (
        SELECT count(*)::INT AS n
        FROM listings_active_with_registration
        WHERE registration_is_active
      )
      SELECT
        active.n AS "activeListings",
        tonight.with_calendar_tonight AS "withCalendarTonight",
        tonight.not_available_tonight AS "notAvailableTonight",
        last_year.n AS "distinctListingsLastYear",
        registry.n AS "registrationsActive",
        registered.n AS "listingsRegistered",
        freshness.airbnb AS "airbnbDate",
        freshness.licenses AS "licensesDate",
        freshness.parcels AS "parcelsDate"
      FROM active, tonight, last_year, registry, registered, freshness
    `,
  });

  const { data: availabilityData, isLoading: availabilityLoading } = useSql<{
    nightDate: number;
    notAvailable: number;
    available: number;
  }>({
    enabled,
    query: `
      SELECT
        night_date AS "nightDate",
        count(*) FILTER (WHERE NOT available)::INT AS "notAvailable",
        count(*) FILTER (WHERE available)::INT AS "available"
      FROM calendar_current
      WHERE night_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL 90 DAY
      GROUP BY ALL
      ORDER BY night_date
    `,
  });

  const { data: strTrendData, isLoading: strTrendLoading } = useSql<{
    month: number;
    distinctListings: number;
  }>({
    enabled,
    query: `
      SELECT
        date_trunc('month', scrape_date)::DATE AS "month",
        count(DISTINCT listing_id)::INT AS "distinctListings"
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
      FROM listings_active l
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
      WHERE is_active
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
  // Not "booked": a night that is not available was taken by a guest or
  // closed off by the host, and the calendar cannot tell the two apart.
  const pctNotAvailable =
    kpi?.withCalendarTonight && kpi.notAvailableTonight != null
      ? Math.round((100 * kpi.notAvailableTonight) / kpi.withCalendarTonight)
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
          label="Not available tonight"
          value={kpiLoading ? '…' : (kpi?.notAvailableTonight ?? '—')}
          detail={
            pctNotAvailable != null
              ? `${pctNotAvailable}% of ${kpi?.withCalendarTonight} on the calendar tonight — booked or host-blocked`
              : 'No calendar data for tonight'
          }
        />
        <StatCard
          label="Distinct listings, last 365 days"
          value={kpiLoading ? '…' : (kpi?.distinctListingsLastYear ?? '—')}
          detail="Under-counts until the archive has run a full year"
        />
        {/* Each source runs on its own schedule, so each has its own date. */}
        <StatCard
          label="Last fetched"
          value={
            kpiLoading ? (
              '…'
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm font-normal">
                {(
                  [
                    ['Airbnb', kpi?.airbnbDate],
                    ['Muni licenses', kpi?.licensesDate],
                    ['Parcels', kpi?.parcelsDate],
                  ] as const
                ).map(([source, date]) => (
                  <div key={source} className="contents">
                    <dt className="text-muted-foreground">{source}</dt>
                    <dd>{date ? shortDate(date) : 'Not yet'}</dd>
                  </div>
                ))}
              </dl>
            )
          }
          detail="UTC dates of each source's latest successful run"
        />
        <StatCard
          label="Active Muni STR registrations"
          value={kpiLoading ? '…' : (kpi?.registrationsActive ?? '—')}
          detail="Read from the Muni's license pages"
        />
        <StatCard
          label="Listings showing an active registration"
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
            Available vs. not, next 90 nights
          </CardTitle>
        </CardHeader>
        <CardContent>
          {availabilityLoading ? (
            <SpinnerPane className="h-64" />
          ) : (
            <ChartContainer config={availabilityConfig} className="h-64 w-full">
              <AreaChart data={availabilityData?.toArray() ?? []}>
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
                  dataKey="notAvailable"
                  type="monotone"
                  stackId="a"
                  fill="var(--color-notAvailable)"
                  stroke="var(--color-notAvailable)"
                  fillOpacity={0.5}
                />
                <Area
                  dataKey="available"
                  type="monotone"
                  stackId="a"
                  fill="var(--color-available)"
                  stroke="var(--color-available)"
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
              Distinct listings seen, by month
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
                    dataKey="distinctListings"
                    fill="var(--color-distinctListings)"
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
              Active listings by year first available
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
              Bedroom-size mix, active listings
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
