import type { WasmSelection } from '@anchorage-str-db/db/rows';
import {
  airbnbListingFirstReviews,
  airbnbListingObservations,
  airbnbScrapeRuns,
} from '@anchorage-str-db/db/schema';
import { toSql } from '@anchorage-str-db/db/sql';
import {
  calendarCurrent,
  latestRegistryDate,
  listings,
  listingsCurrent,
  listingsCurrentWithRegistration,
  registrationsCurrent,
} from '@anchorage-str-db/db/viewSchema';
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
import { asc, eq, gte, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { FC } from 'react';
import { monthLabel, pct, shortDate } from '../format';
import { useRoomStore } from '../store';
import { DataStatusGate } from './DataStatusGate';
import { HostConcentrationCard } from './HostConcentrationCard';
import { RegistrationCard } from './RegistrationCard';
import { StatCard } from './StatCard';

/** Builds queries without a connection; `toSql` renders them for SQLRooms. */
const qb = new QueryBuilder();

// Each of these is a one-row subquery the KPI row cross-joins. The name a
// column is read by is given where it is computed, so every reference to it
// after that is the schema's rather than a string.

/** Tonight's calendar: how many listings are bookable, and how many are not. */
const tonight = qb
  .select({
    operatingTonight: sql<number>`count(*)::INT`.as('operatingTonight'),
    bookedTonight:
      sql<number>`count(*) FILTER (WHERE NOT ${calendarCurrent.available})::INT`.as(
        'bookedTonight',
      ),
  })
  .from(calendarCurrent)
  .where(eq(calendarCurrent.nightDate, sql`CURRENT_DATE`))
  .as('tonight');

const active = qb
  .select({ activeListings: sql<number>`count(*)::INT`.as('activeListings') })
  .from(listings)
  .where(eq(listings.isCurrent, true))
  .as('active');

const lastYear = qb
  .select({
    distinctStrsLastYear:
      sql<number>`count(DISTINCT ${airbnbListingObservations.listingId})::INT`.as(
        'distinctStrsLastYear',
      ),
  })
  .from(airbnbListingObservations)
  .where(
    gte(airbnbListingObservations.scrapeDate, sql`CURRENT_DATE - INTERVAL 365 DAY`),
  )
  .as('last_year');

const latestRun = qb
  .select({
    latestScrapeDate: sql<number | null>`max(${airbnbScrapeRuns.scrapeDate})`.as(
      'latestScrapeDate',
    ),
  })
  .from(airbnbScrapeRuns)
  .as('latest_run');

const registry = qb
  .select({ registrationsCurrent: sql<number>`count(*)::INT`.as('registrationsCurrent') })
  .from(registrationsCurrent)
  .as('registry');

const registryDate = qb
  .select({
    latestRegistryDate: sql<number | null>`${latestRegistryDate.scrapeDate}`.as(
      'latestRegistryDate',
    ),
  })
  .from(latestRegistryDate)
  .as('registry_date');

const registered = qb
  .select({ listingsRegistered: sql<number>`count(*)::INT`.as('listingsRegistered') })
  .from(listingsCurrentWithRegistration)
  .where(eq(listingsCurrentWithRegistration.registrationIsCurrent, true))
  .as('registered');

const KPI_FIELDS = {
  activeListings: active.activeListings,
  operatingTonight: tonight.operatingTonight,
  bookedTonight: tonight.bookedTonight,
  distinctStrsLastYear: lastYear.distinctStrsLastYear,
  latestScrapeDate: latestRun.latestScrapeDate,
  registrationsCurrent: registry.registrationsCurrent,
  listingsRegistered: registered.listingsRegistered,
  latestRegistryDate: registryDate.latestRegistryDate,
};

/** The header's stat cards: one row, each column a count from its own subquery. */
const KPI_QUERY = qb
  .select(KPI_FIELDS)
  .from(active)
  .crossJoin(tonight)
  .crossJoin(lastYear)
  .crossJoin(latestRun)
  .crossJoin(registry)
  .crossJoin(registryDate)
  .crossJoin(registered);

const OCCUPANCY_FIELDS = {
  nightDate: sql<number>`${calendarCurrent.nightDate}`.as('nightDate'),
  booked: sql<number>`count(*) FILTER (WHERE NOT ${calendarCurrent.available})::INT`.as(
    'booked',
  ),
  vacant: sql<number>`count(*) FILTER (WHERE ${calendarCurrent.available})::INT`.as(
    'vacant',
  ),
};

const OCCUPANCY_QUERY = qb
  .select(OCCUPANCY_FIELDS)
  .from(calendarCurrent)
  .where(
    sql`${calendarCurrent.nightDate} BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL 90 DAY`,
  )
  .groupBy(sql`ALL`)
  .orderBy(asc(calendarCurrent.nightDate));

const STR_TREND_FIELDS = {
  month: sql<number>`date_trunc('month', ${airbnbListingObservations.scrapeDate})::DATE`.as(
    'month',
  ),
  distinctStrs: sql<number>`count(DISTINCT ${airbnbListingObservations.listingId})::INT`.as(
    'distinctStrs',
  ),
};

const STR_TREND_QUERY = qb
  .select(STR_TREND_FIELDS)
  .from(airbnbListingObservations)
  .groupBy(sql`ALL`)
  .orderBy(sql`"month"`);

/**
 * A listing's `first_available_date_est` comes from its first review when
 * that predates the first scrape, and is otherwise `first_seen_date`, which
 * makes a listing look newer than it may be.
 */
const datedByReview = sql`coalesce(${listingsCurrent.firstReviewDate} <= ${listingsCurrent.firstSeenDate}, false)`;

const LISTING_AGE_FIELDS = {
  year: sql<string>`year(${listingsCurrent.firstAvailableDateEst})::VARCHAR`.as('year'),
  fromReview: sql<number>`count(*) FILTER (WHERE ${datedByReview})::INT`.as('fromReview'),
  fromFirstSeen: sql<number>`count(*) FILTER (WHERE NOT ${datedByReview})::INT`.as(
    'fromFirstSeen',
  ),
  reviewsUnread:
    sql<number>`count(*) FILTER (WHERE ${airbnbListingFirstReviews.listingId} IS NULL)::INT`.as(
      'reviewsUnread',
    ),
};

const LISTING_AGE_QUERY = qb
  .select(LISTING_AGE_FIELDS)
  .from(listingsCurrent)
  .leftJoin(
    airbnbListingFirstReviews,
    eq(airbnbListingFirstReviews.listingId, listingsCurrent.listingId),
  )
  .groupBy(sql`ALL`)
  .orderBy(sql`"year"`);

/** `bedrooms` is Airbnb's text ("2 bedrooms", "Studio"); rooms usually have none. */
const BEDROOM_MIX_FIELDS = {
  bedroomsLabel: sql<string>`coalesce(${listings.bedrooms}, 'Not listed')`.as(
    'bedroomsLabel',
  ),
  nListings: sql<number>`count(*)::INT`.as('nListings'),
};

const BEDROOM_MIX_QUERY = qb
  .select(BEDROOM_MIX_FIELDS)
  .from(listings)
  .where(eq(listings.isCurrent, true))
  .groupBy(listings.bedrooms)
  .orderBy(
    sql`${listings.bedrooms} IS NULL`,
    sql`try_cast(regexp_extract(${listings.bedrooms}, '^\\d+') AS INTEGER) NULLS FIRST`,
    asc(listings.bedrooms),
  );

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

  const { data: kpiData, isLoading: kpiLoading } = useSql<
    WasmSelection<typeof KPI_FIELDS>
  >({ enabled, query: toSql(KPI_QUERY) });

  const { data: occupancyData, isLoading: occupancyLoading } = useSql<
    WasmSelection<typeof OCCUPANCY_FIELDS>
  >({ enabled, query: toSql(OCCUPANCY_QUERY) });

  const { data: strTrendData, isLoading: strTrendLoading } = useSql<
    WasmSelection<typeof STR_TREND_FIELDS>
  >({ enabled, query: toSql(STR_TREND_QUERY) });

  const { data: listingAgeData, isLoading: listingAgeLoading } = useSql<
    WasmSelection<typeof LISTING_AGE_FIELDS>
  >({ enabled, query: toSql(LISTING_AGE_QUERY) });

  const { data: bedroomMixData, isLoading: bedroomMixLoading } = useSql<
    WasmSelection<typeof BEDROOM_MIX_FIELDS>
  >({ enabled, query: toSql(BEDROOM_MIX_QUERY) });

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
