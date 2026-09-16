import type { WasmSelection } from '@anchorage-str-db/db/rows';
import { toSql } from '@anchorage-str-db/db/sql';
import {
  latestRegistryDate,
  listingsCurrentWithRegistration,
  registrationsCurrent,
} from '@anchorage-str-db/db/viewSchema';
import { useSql } from '@sqlrooms/duckdb';
import {
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
import { asc, desc, eq, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { FC } from 'react';
import { pct, shortDate } from '../format';
import {
  registrationStatusSql,
  type RegistrationStatus,
} from '../registrationStatus';
import { useRoomStore } from '../store';

const COUNCILS_SHOWN = 15;

const statusConfig = {
  registered: { label: 'Registered', color: 'hsl(var(--chart-2))' },
  notCurrent: { label: 'Registration not current', color: 'hsl(var(--chart-4))' },
  notInRegistry: { label: 'Number not in registry', color: 'hsl(var(--chart-5))' },
  noNumber: { label: 'No number shown', color: 'hsl(var(--chart-1))' },
} satisfies ChartConfig;

const councilConfig = {
  registrations: { label: 'Current registrations', color: 'hsl(var(--chart-3))' },
  listings: { label: 'Airbnb listings citing them', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig;

/** Builds queries without a connection; `toSql` renders them for SQLRooms. */
const qb = new QueryBuilder();

/** Every current listing with how its registration number matched. */
const listingsWithStatus = qb
  .select({
    roomType: listingsCurrentWithRegistration.roomType,
    status: registrationStatusSql(listingsCurrentWithRegistration).as('status'),
  })
  .from(listingsCurrentWithRegistration)
  .as('listings');

/** `status` is the subquery's own column, so both queries below count it. */
const listingsWith = (status: RegistrationStatus) =>
  sql<number>`count(*) FILTER (WHERE ${listingsWithStatus.status} = ${status})::INT`;

const STATUS_COUNTS = {
  registered: listingsWith('Registered').as('registered'),
  notCurrent: listingsWith('Registration not current').as('notCurrent'),
  notInRegistry: listingsWith('Number not in registry').as('notInRegistry'),
  noNumber: listingsWith('No number shown').as('noNumber'),
};

const registrations = qb
  .select({ registrations: sql<number>`count(*)::INT`.as('registrations') })
  .from(registrationsCurrent);

const registrationsWithoutListing = qb
  .select({
    registrationsWithoutListing: sql<number>`count(*)::INT`.as(
      'registrationsWithoutListing',
    ),
  })
  .from(registrationsCurrent)
  .where(eq(registrationsCurrent.airbnbListingsCurrent, 0));

const registryDate = qb
  .select({ registryDate: sql<number | null>`${latestRegistryDate.scrapeDate}`.as('registryDate') })
  .from(latestRegistryDate);

const SUMMARY_FIELDS = {
  listings: sql<number>`count(*)::INT`.as('listings'),
  ...STATUS_COUNTS,
  registrations: sql<number>`${registrations}`.as('registrations'),
  registrationsWithoutListing: sql<number>`${registrationsWithoutListing}`.as(
    'registrationsWithoutListing',
  ),
  registryDate: sql<number | null>`${registryDate}`.as('registryDate'),
};

const SUMMARY_QUERY = qb.select(SUMMARY_FIELDS).from(listingsWithStatus);

const BY_ROOM_TYPE_FIELDS = {
  roomType: sql<string>`coalesce(${listingsWithStatus.roomType}, 'Not listed')`.as(
    'roomType',
  ),
  ...STATUS_COUNTS,
};

const BY_ROOM_TYPE_QUERY = qb
  .select(BY_ROOM_TYPE_FIELDS)
  .from(listingsWithStatus)
  .groupBy(listingsWithStatus.roomType)
  .orderBy(sql`count(*) DESC`);

const COUNCIL_FIELDS = {
  council: sql<string>`coalesce(${registrationsCurrent.communityCouncil}, 'Address not geocoded')`.as(
    'council',
  ),
  registrations: sql<number>`count(*)::INT`.as('registrations'),
  listings: sql<number>`sum(${registrationsCurrent.airbnbListingsCurrent})::INT`.as(
    'listings',
  ),
};

const COUNCIL_QUERY = qb
  .select(COUNCIL_FIELDS)
  .from(registrationsCurrent)
  .groupBy(registrationsCurrent.communityCouncil)
  .orderBy(desc(sql`count(*)`), asc(registrationsCurrent.communityCouncil))
  .limit(COUNCILS_SHOWN);

export const RegistrationCard: FC = () => {
  const enabled = useRoomStore((s) => s.dataInit.status) === 'ready';

  const { data: summaryData, isLoading: summaryLoading } = useSql<
    WasmSelection<typeof SUMMARY_FIELDS>
  >({ enabled, query: toSql(SUMMARY_QUERY) });

  const { data: byRoomTypeData, isLoading: byRoomTypeLoading } = useSql<
    WasmSelection<typeof BY_ROOM_TYPE_FIELDS>
  >({ enabled, query: toSql(BY_ROOM_TYPE_QUERY) });

  const { data: councilData, isLoading: councilLoading } = useSql<
    WasmSelection<typeof COUNCIL_FIELDS>
  >({ enabled, query: toSql(COUNCIL_QUERY) });

  const s = summaryData?.toArray()[0];
  const byCouncil = councilData?.toArray() ?? [];

  return (
    <Card>
      <CardHeader className="gap-2">
        <CardTitle className="text-sm font-medium">Municipal STR registration</CardTitle>
        <CardDescription className="text-xs">
          Matches the registration number on each Airbnb listing page to the
          Municipal Clerk's published registrations
          {s?.registryDate ? ` as of ${shortDate(s.registryDate)}` : ''}. The Muni
          publishes only active registrations, and a number issued since its last
          publish shows as not in the registry.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summaryLoading ? (
          <SpinnerPane className="h-12" />
        ) : s && s.registryDate == null ? (
          <p className="text-muted-foreground text-sm">
            This database has no registry run. Run <code>pnpm registry</code> to
            record the Muni's registrations.
          </p>
        ) : s ? (
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{pct(s.registered, s.listings)}</span>{' '}
            ({s.registered} of {s.listings}) of current listings show a current
            registration. {s.notInRegistry} show a number not in the registry,{' '}
            {s.notCurrent} a registration no longer published, and {s.noNumber} no
            number. Of <span className="tabular-nums">{s.registrations}</span> current
            registrations,{' '}
            <span className="font-semibold tabular-nums">
              {s.registrationsWithoutListing}
            </span>{' '}
            are cited by no current Airbnb listing; they may list on other platforms
            or not be operating.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <div className="text-muted-foreground mb-1 text-xs">
              Current listings by room type and registration status
            </div>
            {byRoomTypeLoading ? (
              <SpinnerPane className="h-72" />
            ) : (
              <ChartContainer config={statusConfig} className="h-72 w-full">
                <BarChart data={byRoomTypeData?.toArray() ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="roomType" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={40} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {(Object.keys(statusConfig) as (keyof typeof statusConfig)[]).map((key) => (
                    <Bar key={key} dataKey={key} stackId="status" fill={`var(--color-${key})`} />
                  ))}
                </BarChart>
              </ChartContainer>
            )}
          </div>
          <div>
            <div className="text-muted-foreground mb-1 text-xs">
              Community councils with the most current registrations (top{' '}
              {COUNCILS_SHOWN})
            </div>
            {councilLoading ? (
              <SpinnerPane className="h-72" />
            ) : (
              <ChartContainer config={councilConfig} className="h-72 w-full">
                <BarChart data={byCouncil} layout="vertical" barGap={0}>
                  <CartesianGrid horizontal={false} />
                  <XAxis type="number" tickLine={false} axisLine={false} />
                  <YAxis
                    type="category"
                    dataKey="council"
                    tickLine={false}
                    axisLine={false}
                    width={130}
                    interval={0}
                    tick={{ fontSize: 10 }}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="registrations" fill="var(--color-registrations)" />
                  <Bar dataKey="listings" fill="var(--color-listings)" />
                </BarChart>
              </ChartContainer>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
