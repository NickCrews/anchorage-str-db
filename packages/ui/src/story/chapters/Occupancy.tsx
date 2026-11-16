import type { FC } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { int, monthLabel, monthName, pct1, shortDate } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { BLOCK_RUN_NIGHTS } from '../../model/estimates';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { listingMonthsSql } from '../sql';
import type { Model } from '../model';
import { axisProps, Caveat, ChartBox, COLOR, N, Segmented, Select, Swatch, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfHistogram } from '../xf/XfHistogram';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

type Top = 'nights' | 'distribution' | 'months';
interface VisualState {
  top: Top;
  month: string;
}

/** The est_listing_months occupancy column for a model. */
const occupancyCol = (m: Model) => (m === 'low' ? 'occupancy_low' : m === 'high' ? 'occupancy_high' : 'occupancy');

export const Occupancy: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  const { row: s } = useRow<{
    listings: number;
    p20: number;
    p50: number;
    p80: number;
    p50Low: number;
    p50High: number;
    blockedShare: number;
    mostlyBlocked: number;
  }>(
    `SELECT count(*)::INT AS listings,
       quantile_cont(occupancy, 0.2) AS p20, quantile_cont(occupancy, 0.5) AS p50,
       quantile_cont(occupancy, 0.8) AS p80,
       quantile_cont(occupancy_low, 0.5) AS "p50Low", quantile_cont(occupancy_high, 0.5) AS "p50High",
       sum(nights_blocked) / sum(nights) AS "blockedShare",
       count(*) FILTER (WHERE nights_blocked > nights / 2)::INT AS "mostlyBlocked"
     FROM (${listingMonthsSql(focus)})`,
    { enabled: !!focus },
  );
  const month = meta ? monthName(meta.focusMonth) : '…';

  return (
    <Chapter
      id="q4"
      title="How often are they booked?"
      lede={
        <>
          Airbnb shows which nights on a listing's calendar are open and which are closed, but not why a night is
          closed: a guest may have booked it, or the owner may have closed it to stay there themselves, take a
          break or rent to a long-term tenant. So we estimate. Occupancy here is the share of the nights a listing
          was offered that guests booked.
        </>
      }
      steps={[
        <>
          Every night of every listing, colored by what its calendar showed the day before. If we saw a night
          open and later saw it close, a guest probably booked it. If it was already closed when we first looked,
          a guest probably booked it too, unless it is part of a closed stretch of more than {BLOCK_RUN_NIGHTS}{' '}
          nights, which looks more like the owner closing the calendar.
        </>,
        <>
          In <N>{month}</N>, <N>{pct1(s?.blockedShare)}</N> of all nights on these listings were closed by owners, and{' '}
          <N>{int(s?.mostlyBlocked)}</N> listings were closed for more than half the month. Drag across the{' '}
          <em>nights closed</em> column at the top of the table to see which.
        </>,
        <>
          Of the nights they offered in {month}, the typical listing was booked <N>{pct1(s?.p50)}</N> of the time.
          Most were booked between <N>{pct1(s?.p20)}</N> and <N>{pct1(s?.p80)}</N> of the time.
          <Caveat>
            Counting only bookings we saw happen, the typical listing was booked {pct1(s?.p50Low)} of the time;
            counting every closed night as booked, {pct1(s?.p50High)}. See Methodology at the top left.
          </Caveat>
        </>,
        <>
          Month by month. Months that haven't happened yet show only bookings made so far, so they will rise as
          the dates get closer. A full year of records will show the seasons.
        </>,
      ]}
      visual={(step) => <Visual step={step} focusMonth={focus} />}
    />
  );
};

const Visual: FC<{ step: number; focusMonth: string }> = ({ step, focusMonth }) => {
  const months = useStartedMonths();
  const { state, update, exploring, reset } = useStepState<VisualState>(step, [
    { top: 'nights', month: focusMonth },
    { top: 'nights', month: focusMonth },
    { top: 'distribution', month: focusMonth },
    { top: 'months', month: focusMonth },
  ]);
  return (
    <XfProvider chapterId="q4" month={state.month}>
      <ChapterGrid
      exploring={exploring}
      onReset={reset}
      controls={
        <>
          <Segmented
            value={state.top}
            options={[
              { value: 'nights', label: 'Every night' },
              { value: 'distribution', label: 'All listings' },
              { value: 'months', label: 'By month' },
            ]}
            onChange={(top) => update({ top })}
          />
          <Select
            label="Month"
            value={state.month}
            options={months.map((m) => ({ value: m.value, label: m.label }))}
            onChange={(month) => update({ month })}
          />
        </>
      }
      chart={
        state.top === 'nights' ? (
          <Nights />
        ) : state.top === 'distribution' ? (
          <XfHistogram column="_occupancy" label="Share of offered nights that were booked (%)" bins={20} />
        ) : (
          <ByMonth />
        )
      }
      caption={
        state.top === 'nights' ? (
          <span className="flex flex-wrap gap-3">
            <Swatch color={COLOR.booked} label="Booked (seen happen)" />
            <Swatch color={COLOR.bookedInferred} label="Booked (already closed when we looked)" />
            <Swatch color={COLOR.blocked} label="Closed by owner" />
            <Swatch color={COLOR.available} label="Open" />
            <span>Dashed line: today. Later nights show bookings so far.</span>
          </span>
        ) : state.top === 'months' ? (
          'The shaded band covers the middle 60% of listings and the line is the typical one; dashes show the low and high estimates. * Bookings so far.'
        ) : (
          'Number of listings by how booked they were. A listing closed all month offered no nights and is left out.'
        )
      }
      side={<XfSide mapColor={{ field: 'occupancy %', type: 'quantile', scheme: 'OrRd', title: 'Booked (%)' }} columns={TABLE_COLUMNS.occupancy} />}
    />
  </XfProvider>
  );
};

const Nights: FC = () => {
  const xf = useXf();
  const { meta } = useStory();
  const { rows, isLoading, error } = useRows<{ night: number; booked: number; inferred: number; blocked: number; available: number }>(
    `SELECT n.night_date AS night,
       count(*) FILTER (WHERE state = 'booked_observed')::INT AS booked,
       count(*) FILTER (WHERE state = 'booked_inferred')::INT AS inferred,
       count(*) FILTER (WHERE state = 'blocked')::INT AS blocked,
       count(*) FILTER (WHERE state = 'available')::INT AS available
     FROM est_nights n
     WHERE n.night_date < (SELECT latest_run_date + INTERVAL 120 DAY FROM est_run_dates) AND ${selectedListingsSql(xf, 'n')}
     GROUP BY ALL ORDER BY night`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="night" {...axisProps} tickFormatter={(v: number) => shortDate(v)} minTickGap={32} />
          <YAxis {...axisProps} width={40} />
          <Tooltip {...tooltipProps} labelFormatter={(v) => shortDate(v as number)} />
          {meta && <ReferenceLine x={meta.latestRunDate} stroke="hsl(var(--foreground))" strokeDasharray="4 3" />}
          <Area dataKey="booked" name="Booked, observed" stackId="a" fill={COLOR.booked} stroke="none" fillOpacity={0.9} isAnimationActive={false} />
          <Area dataKey="inferred" name="Booked, inferred" stackId="a" fill={COLOR.bookedInferred} stroke="none" fillOpacity={0.9} isAnimationActive={false} />
          <Area dataKey="blocked" name="Blocked" stackId="a" fill={COLOR.blocked} stroke="none" fillOpacity={0.8} isAnimationActive={false} />
          <Area dataKey="available" name="Open" stackId="a" fill={COLOR.available} stroke="none" fillOpacity={0.6} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const ByMonth: FC = () => {
  const xf = useXf();
  const { model } = useStory();
  const col = occupancyCol(model);
  const { rows, isLoading, error } = useRows<{ month: number; p20: number; p50: number; p80: number; p50Low: number; p50High: number; isPast: boolean }>(
    `SELECT m.month,
       quantile_cont(${col}, 0.2) AS p20, quantile_cont(${col}, 0.5) AS p50, quantile_cont(${col}, 0.8) AS p80,
       quantile_cont(occupancy_low, 0.5) AS "p50Low", quantile_cont(occupancy_high, 0.5) AS "p50High",
       bool_and(m.is_past) AS "isPast"
     FROM est_listing_months m
     WHERE ${selectedListingsSql(xf, 'm')} AND m.month <= (SELECT latest_run_date + INTERVAL 300 DAY FROM est_run_dates)
     GROUP BY m.month ORDER BY m.month`,
  );
  const data = rows.map((r) => ({ ...r, label: monthLabel(r.month) + (r.isPast ? '' : '*'), band: [r.p20, r.p80] as [number, number] }));
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={40} domain={[0, 1]} tickFormatter={(n: number) => pct1(n)} />
          <Tooltip {...tooltipProps} formatter={(v) => (Array.isArray(v) ? v.map((x) => pct1(x as number)).join(' – ') : pct1(v as number))} />
          <Area dataKey="band" name="Middle 60%" stroke="none" fill={COLOR.band} isAnimationActive={false} />
          <Line dataKey="p50" name="Typical" stroke={COLOR.primary} strokeWidth={2} isAnimationActive={false} />
          <Line dataKey="p50Low" name="Low estimate" stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
          <Line dataKey="p50High" name="High estimate" stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};
