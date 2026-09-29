import type { WasmSelection } from '@anchorage-str-db/db/rows';
import { toSql } from '@anchorage-str-db/db/sql';
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
import {
  BY_LISTING_TYPE_FIELDS,
  BY_LISTING_TYPE_QUERY,
  COUNCIL_FIELDS,
  COUNCIL_QUERY,
  COUNCILS_SHOWN,
  SUMMARY_FIELDS,
  SUMMARY_QUERY,
} from '../queries/registrationCard';
import { useRoomStore } from '../store';

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

export const RegistrationCard: FC = () => {
  const enabled = useRoomStore((s) => s.dataInit.status) === 'ready';

  const { data: summaryData, isLoading: summaryLoading } = useSql<
    WasmSelection<typeof SUMMARY_FIELDS>
  >({ enabled, query: toSql(SUMMARY_QUERY) });

  const { data: byListingTypeData, isLoading: byListingTypeLoading } = useSql<
    WasmSelection<typeof BY_LISTING_TYPE_FIELDS>
  >({ enabled, query: toSql(BY_LISTING_TYPE_QUERY) });

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
          Matches the registration id on each Airbnb listing page to the
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
