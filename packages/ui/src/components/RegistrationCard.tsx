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
import type { FC } from 'react';
import { pct, shortDate } from '../format';
import { registrationStatusSql } from '../registrationStatus';
import { useRoomStore } from '../store';

const COUNCILS_SHOWN = 15;

const statusConfig = {
  registered: { label: 'Registered', color: 'hsl(var(--chart-2))' },
  lapsed: { label: 'Registration lapsed', color: 'hsl(var(--chart-4))' },
  notInRegistry: { label: 'Id not in registry', color: 'hsl(var(--chart-5))' },
  noId: { label: 'No id shown', color: 'hsl(var(--chart-1))' },
} satisfies ChartConfig;

const councilConfig = {
  registrations: { label: 'Active registrations', color: 'hsl(var(--chart-3))' },
  listings: { label: 'Airbnb listings citing them', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig;

const STATUS_COUNTS = `
  count(*) FILTER (WHERE status = 'Registered')::INT AS "registered",
  count(*) FILTER (WHERE status = 'Registration lapsed')::INT AS "lapsed",
  count(*) FILTER (WHERE status = 'Id not in registry')::INT AS "notInRegistry",
  count(*) FILTER (WHERE status = 'No id shown')::INT AS "noId"
`;

const LISTINGS_WITH_STATUS = `
  SELECT r.listing_type, ${registrationStatusSql('r')} AS status
  FROM listings_active_with_registration r
`;

export const RegistrationCard: FC = () => {
  const enabled = useRoomStore((s) => s.dataInit.status) === 'ready';

  const { data: summaryData, isLoading: summaryLoading } = useSql<{
    listings: number;
    registered: number;
    lapsed: number;
    notInRegistry: number;
    noId: number;
    registrations: number;
    registrationsWithoutListing: number;
    registryDate: number | null;
  }>({
    enabled,
    query: `
      SELECT
        count(*)::INT AS "listings",
        ${STATUS_COUNTS},
        (SELECT count(*) FROM registrations_active)::INT AS "registrations",
        (SELECT count(*) FROM registrations_active WHERE airbnb_listings_active = 0)::INT
          AS "registrationsWithoutListing",
        (SELECT scrape_date FROM latest_registry_date) AS "registryDate"
      FROM (${LISTINGS_WITH_STATUS})
    `,
  });

  const { data: byListingTypeData, isLoading: byListingTypeLoading } = useSql<{
    listingType: string;
    registered: number;
    lapsed: number;
    notInRegistry: number;
    noId: number;
  }>({
    enabled,
    query: `
      SELECT coalesce(listing_type, 'Not listed') AS "listingType", ${STATUS_COUNTS}
      FROM (${LISTINGS_WITH_STATUS})
      GROUP BY listing_type
      ORDER BY count(*) DESC
    `,
  });

  const { data: councilData, isLoading: councilLoading } = useSql<{
    council: string;
    registrations: number;
    listings: number;
  }>({
    enabled,
    query: `
      SELECT
        coalesce(community_council, 'Address not geocoded') AS "council",
        count(*)::INT AS "registrations",
        sum(airbnb_listings_active)::INT AS "listings"
      FROM registrations_active
      GROUP BY community_council
      ORDER BY count(*) DESC, community_council
      LIMIT ${COUNCILS_SHOWN}
    `,
  });

  const s = summaryData?.toArray()[0];
  const byCouncil = councilData?.toArray() ?? [];

  return (
    <Card>
      <CardHeader className="gap-2">
        <CardTitle className="text-sm font-medium">Municipal STR registration</CardTitle>
        <CardDescription className="text-xs">
          Matches the registration id on each Airbnb listing page to the STR
          certificates on the Muni's license pages
          {s?.registryDate ? ` as of ${shortDate(s.registryDate)}` : ''}. A number
          issued since the last license scan shows as not in the registry.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summaryLoading ? (
          <SpinnerPane className="h-12" />
        ) : s && s.registryDate == null ? (
          <p className="text-muted-foreground text-sm">
            This database has no registrations.
          </p>
        ) : s ? (
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{pct(s.registered, s.listings)}</span>{' '}
            ({s.registered} of {s.listings}) of active listings show an active
            registration. {s.notInRegistry} show an id not in the registry,{' '}
            {s.lapsed} a lapsed registration, and {s.noId} no id. Of{' '}
            <span className="tabular-nums">{s.registrations}</span> active
            registrations,{' '}
            <span className="font-semibold tabular-nums">
              {s.registrationsWithoutListing}
            </span>{' '}
            are cited by no active Airbnb listing; they may list on other platforms
            or not be operating.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <div className="text-muted-foreground mb-1 text-xs">
              Active listings by listing type and registration status
            </div>
            {byListingTypeLoading ? (
              <SpinnerPane className="h-72" />
            ) : (
              <ChartContainer config={statusConfig} className="h-72 w-full">
                <BarChart data={byListingTypeData?.toArray() ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="listingType" tickLine={false} axisLine={false} />
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
              Community councils with the most active registrations (top{' '}
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
